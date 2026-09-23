"use client";

import { memo, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { DocumentTextRow } from "@/lib/types";
import type { HighlightSegmentSpec } from "../offsets";

/* ------------------------------------------------------------ pdfjs load */

type Pdfjs = typeof import("pdfjs-dist");

// Pages render one at a time: a burst of parallel canvas rasterisations
// freezes the main thread for seconds and clicks land late.
let renderChain: Promise<unknown> = Promise.resolve();
function enqueueRender<T>(job: () => Promise<T>): Promise<T> {
  const run = renderChain.then(job);
  renderChain = run.catch(() => undefined);
  return run;
}
let pdfjsPromise: Promise<Pdfjs> | null = null;
function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/* ------------------------------------------------------- text matching */

/**
 * Strip ALL whitespace; keep a map from normalized indices to original ones.
 * PDF extraction and the on-screen text layer disagree about where spaces
 * fall (item splits, CJK boundaries), so matching ignores whitespace entirely.
 */
function buildNormMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!SKIP_RE.test(ch)) {
      norm += ch;
      map.push(i);
    }
  }
  return { norm, map };
}

// whitespace AND control/invisible chars are skippable on both sides
const SKIP_RE = /[\s\u0000-\u001F\u007F-\u00A0\u00AD]/;
const SKIP_RE_G = /[\s\u0000-\u001F\u007F-\u00A0\u00AD]+/g;
const normWs = (s: string) => s.replace(SKIP_RE_G, "");
const strippedLen = (s: string) => normWs(s).length;

/**
 * Map a range of the STORED normalized text onto the LAYER normalized text.
 * The two come from the same pdf engine, so positions normally coincide —
 * verify by substring equality and only fall back to a proximity search when
 * they drift (ligatures, odd glyphs).
 */
function mapStoredToLayer(
  layerNorm: string,
  storedNorm: string,
  idx: number,
  len: number,
): number {
  if (len <= 0) return -1;
  if (idx + len <= layerNorm.length && layerNorm.substr(idx, len) === storedNorm.substr(idx, len)) {
    return idx;
  }
  const quote = storedNorm.substr(idx, len);
  if (!quote) return -1;
  let best = -1;
  let bestDist = Infinity;
  let i = layerNorm.indexOf(quote);
  while (i !== -1) {
    const d = Math.abs(i - idx);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
    i = layerNorm.indexOf(quote, i + 1);
  }
  return best;
}

/** Content bounding box of a page, in scale-1 page units. */
interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Detect where the ink actually is on a page by rendering a small thumbnail
 * and scanning pixels. Returns null for blank pages.
 */
async function inkBBox(page: {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: object): { promise: Promise<unknown> };
}): Promise<CropBox | null> {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = 160 / vp1.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (data[i] < 242 || data[i + 1] < 242 || data[i + 2] < 242) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    x: minX / scale,
    y: minY / scale,
    w: (maxX - minX + 1) / scale,
    h: (maxY - minY + 1) / scale,
  };
}

export interface PdfRegion {
  id: string;
  color: string;
  page_no: number;
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
}

export interface CapturedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const REGION_COLORS: Record<string, string> = {
  amber: "#e0b446",
  green: "#5f9e5f",
  blue: "#5f83ac",
  rose: "#c06a76",
};
const REGION_FILL: Record<string, string> = {
  amber: "rgba(240,201,86,0.10)",
  green: "rgba(122,184,122,0.10)",
  blue: "rgba(122,158,199,0.10)",
  rose: "rgba(214,138,148,0.10)",
};
const SWATCHES: { color: string; hex: string }[] = [
  { color: "amber", hex: "#f0c956" },
  { color: "green", hex: "#7ab87a" },
  { color: "blue", hex: "#7a9ec7" },
  { color: "rose", hex: "#d68a94" },
];

export interface PdfSelection {
  start: number;
  end: number;
  rect: DOMRect;
}

/* --------------------------------------------------------- link annotations */

/** The subset of a pdf.js annotation the link layer reads. */
interface LinkAnnotationLike {
  id?: string;
  subtype?: string;
  rect?: number[];
  url?: string;
  unsafeUrl?: string;
  dest?: string | unknown[];
}

/** A link rect in SHEET coordinates (full page at scale — crop shift applies). */
interface PdfLinkRect {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  url?: string;
  dest?: string | unknown[];
}

interface OverlayTarget {
  id: string;
  color: string;
  start: number;
  end: number;
  active: boolean;
}

const OVERLAY_COLORS: Record<string, string> = {
  amber: "rgba(240,201,86,0.42)",
  green: "rgba(122,184,122,0.38)",
  blue: "rgba(122,158,199,0.38)",
  rose: "rgba(214,138,148,0.38)",
  "search-hit": "rgba(0,0,0,0.14)",
  "search-current": "rgba(240,201,86,0.65)",
};

interface PdfViewProps {
  url: string;
  pages: DocumentTextRow[];
  highlights: HighlightSegmentSpec[];
  searchSpecs: HighlightSegmentSpec[];
  activeId: string | null;
  onHighlightClick: (id: string) => void;
  onTextSelected: (sel: PdfSelection | null) => void;
  onDocLoaded: (doc: PDFDocumentProxy) => void;
  /** Fired whenever a page paints its overlays — margin layout re-measures. */
  onLayoutTick?: () => void;
  /** Captured regions to render (all pages; filtered per page internally). */
  regions?: PdfRegion[];
  /** Capture tool: when on, the cursor becomes a crosshair and drags frame a rect. */
  captureMode?: boolean;
  onCapture?: (pageNo: number, rect: CapturedRect, dataUrl: string, color: string) => void;
  /** The rect is framed (mouse released): drawing is over, cursor can revert. */
  onFramed?: () => void;
  /** Zoom factor on top of fit-to-width (1 = fit). Overflow pans horizontally. */
  zoom?: number;
}

/**
 * Faithful document view: renders the ORIGINAL pdf pages (canvas + selectable
 * text layer) with highlight/search overlays reconciled against the stored
 * text layer, so threads, connectors and search keep working.
 */
export function PdfView({
  url,
  pages,
  highlights,
  searchSpecs,
  activeId,
  onHighlightClick,
  onTextSelected,
  onDocLoaded,
  onLayoutTick,
  regions = [],
  captureMode = false,
  onCapture,
  onFramed,
  zoom = 1,
}: PdfViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }[]>([]);
  const [crop, setCrop] = useState<CropBox | null>(null);
  const [error, setError] = useState("");
  // Bumping this re-runs the load effect after a failure ("Try again").
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [rootW, setRootW] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<Pdfjs["getDocument"]> | null = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        task = pdfjs.getDocument({ url });
        const loaded = await task.promise;
        if (cancelled) return;
        const list: { w: number; h: number }[] = [];
        for (let n = 1; n <= loaded.numPages; n++) {
          const page = await loaded.getPage(n);
          const vp = page.getViewport({ scale: 1 });
          list.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) return;

        // Smart margin trim: union of the ink boxes of a few sampled pages,
        // applied uniformly, computed BEFORE first paint so pages mount with
        // their final geometry (no visible re-layout). Falls back to the full
        // page when margins are already small or detection is unreliable.
        let computedCrop: CropBox | null = null;
        try {
          const sampleCount = Math.min(6, loaded.numPages);
          let u: CropBox | null = null;
          for (let n = 1; n <= sampleCount; n++) {
            const pg = await loaded.getPage(n);
            const bb = await inkBBox(pg);
            if (!bb) continue;
            u = u
              ? {
                  x: Math.min(u.x, bb.x),
                  y: Math.min(u.y, bb.y),
                  w: Math.max(u.x + u.w, bb.x + bb.w) - Math.min(u.x, bb.x),
                  h: Math.max(u.y + u.h, bb.y + bb.h) - Math.min(u.y, bb.y),
                }
              : bb;
          }
          if (!cancelled && u) {
          const pageW = list[0].w;
          const pageH = list[0].h;
          const pad = pageW * 0.015;
          let cx = Math.max(0, u.x - pad);
          let cw = Math.min(pageW - cx, u.w + 2 * pad);
          // don't over-zoom tiny content; don't bother when margins are small
          if (cw < pageW * 0.4) {
            const grow = (pageW * 0.4 - cw) / 2;
            cx = Math.max(0, cx - grow);
            cw = Math.min(pageW - cx, pageW * 0.4);
          }
          // vertical trim: shave the sheet's top/bottom margins the same way
          let cy = Math.max(0, u.y - pad);
          let ch = Math.min(pageH - cy, u.h + 2 * pad);
          if (ch < pageH * 0.5) {
            const grow = (pageH * 0.5 - ch) / 2;
            cy = Math.max(0, cy - grow);
            ch = Math.min(pageH - cy, pageH * 0.5);
          }
          if (ch >= pageH * 0.95) {
            cy = 0;
            ch = pageH;
          }
          if (cw < pageW * 0.92 || ch < pageH * 0.95) {
            computedCrop = { x: cx, y: cy, w: cw, h: ch };
          }
          }
        } catch {
          // keep full pages
        }
        if (cancelled) return;
        setCrop(computedCrop);
        setDoc(loaded);
        setDims(list);
        onDocLoaded(loaded);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the PDF");
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, loadAttempt]);

  // Re-attach when the error UI unmounts/remounts the measured root div.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setRootW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [error]);

  /* selection → global offsets */
  const handleMouseUp = useCallback(() => {
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        onTextSelected(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const elOf = (node: Node): Element | null =>
        node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      const startWrapper = elOf(range.startContainer)?.closest<HTMLElement>("[data-page]") ?? null;
      const startLayer = startWrapper?.querySelector<HTMLElement>(".pdf-textlayer") ?? null;
      if (!startWrapper || !startLayer || !rootRef.current?.contains(startWrapper)) {
        onTextSelected(null);
        return;
      }
      // A drag can end on ANOTHER page (offsets are global, so the selection
      // legitimately spans pages) or outside any page (clamp to the start one).
      let endWrapper = elOf(range.endContainer)?.closest<HTMLElement>("[data-page]") ?? null;
      let endLayer = endWrapper?.querySelector<HTMLElement>(".pdf-textlayer") ?? null;
      if (!endWrapper || !endLayer || !rootRef.current.contains(endWrapper)) {
        endWrapper = startWrapper;
        endLayer = startLayer;
      }

      /**
       * Map one boundary of the live selection to a GLOBAL offset through the
       * given page's whitespace-stripped norm map. The selection is clamped to
       * that page's text layer, then positional mapping (char count before the
       * fragment = index in the stored norm text) with a nearest-occurrence
       * fallback for drift (ligatures/odd glyphs) — same maths as before, now
       * applied per boundary page instead of only the start page.
       */
      const resolveBoundary = (
        wrapper: HTMLElement,
        layer: HTMLElement,
        boundary: "start" | "end",
      ): number | null => {
        const pageNo = Number(wrapper.dataset.page);
        const pageRow = pages.find((p) => p.page_no === pageNo);
        if (!pageRow) return null;
        // clamp the range to THIS page's fragment of the selection
        const frag = range.cloneRange();
        try {
          if (!layer.contains(range.startContainer)) frag.setStart(layer, 0);
          if (!layer.contains(range.endContainer)) frag.setEnd(layer, layer.childNodes.length);
        } catch {
          return null;
        }
        // text before the fragment inside this page's layer
        const pre = document.createRange();
        pre.selectNodeContents(layer);
        try {
          pre.setEnd(frag.startContainer, frag.startOffset);
        } catch {
          return null;
        }
        const prefixLen = strippedLen(pre.toString());
        const normSel = normWs(frag.toString());
        if (normSel.length < 1) return null;
        const { norm: storedNorm, map } = buildNormMap(pageRow.text);
        let normIdx = prefixLen;
        if (storedNorm.substr(normIdx, normSel.length) !== normSel) {
          // drifted — locate the nearest occurrence
          let best = -1;
          let bestDist = Infinity;
          let idx = storedNorm.indexOf(normSel);
          while (idx !== -1) {
            const dist = Math.abs(idx - prefixLen);
            if (dist < bestDist) {
              bestDist = dist;
              best = idx;
            }
            idx = storedNorm.indexOf(normSel, idx + 1);
          }
          if (best === -1) return null;
          normIdx = best;
        }
        if (map[normIdx] === undefined || map[normIdx + normSel.length - 1] === undefined) {
          return null;
        }
        return boundary === "start"
          ? pageRow.char_start + map[normIdx]
          : pageRow.char_start + map[normIdx + normSel.length - 1] + 1;
      };

      const start = resolveBoundary(startWrapper, startLayer, "start");
      let end = resolveBoundary(endWrapper, endLayer, "end");
      if (end === null && endLayer !== startLayer) {
        // the end-page fragment was empty/unmappable — truncate to the start page
        end = resolveBoundary(startWrapper, startLayer, "end");
      }
      if (start === null || end === null || end <= start) {
        onTextSelected(null);
        return;
      }
      // anchor the palette at the END of the selection: last non-empty rect
      const selRects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      onTextSelected({
        start,
        end,
        rect: selRects.length ? selRects[selRects.length - 1] : range.getBoundingClientRect(),
      });
    });
  }, [pages, onTextSelected]);

  if (error) {
    return (
      <div className="grid h-64 place-items-center">
        <div className="text-center">
          <p className="text-sm text-neutral-600">The PDF could not be loaded.</p>
          <button
            type="button"
            onClick={() => {
              setError("");
              setDoc(null);
              setDims([]);
              setCrop(null);
              setLoadAttempt((n) => n + 1);
            }}
            className="mt-3 rounded border border-neutral-400 px-3 py-1 text-sm text-neutral-800 hover:bg-neutral-100"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Fit-to-width: the page fills the text column (never crossing into the
  // chat area), capped so lines stay readable on very wide monitors.
  // `zoom` multiplies on top; the overflowing width pans inside the zoomport.
  const MAX_PAGE_WIDTH = 1100;
  const width = Math.min(rootW > 0 ? rootW : 680, MAX_PAGE_WIDTH) * (zoom ?? 1);

  return (
    <div ref={rootRef} onMouseUp={handleMouseUp}>
      {dims.map((d, i) => {
        const pageNo = i + 1;
        const pageRow = pages.find((p) => p.page_no === pageNo) ?? null;
        const targets: OverlayTarget[] = pageRow
          ? [...searchSpecs, ...highlights]
              .filter((h) => h.start < pageRow.char_end && h.end > pageRow.char_start)
              .map((h) => ({
                id: h.id,
                color: h.color,
                start: h.start,
                end: h.end,
                active: h.id === activeId,
              }))
          : [];
        const scale = crop ? width / crop.w : width / d.w;
        return (
          <PdfPage
            key={`${pageNo}-${width.toFixed(0)}-${crop ? crop.x.toFixed(0) + "x" + crop.w.toFixed(0) : "full"}`}
            doc={doc}
            pageNo={pageNo}
            width={width}
            aspect={crop ? crop.h / crop.w : d.h / d.w}
            crop={crop}
            scale={scale}
            pageRow={pageRow}
            targets={targets}
            regions={regions.filter((r) => r.page_no === pageNo)}
            captureMode={captureMode}
            onCapture={onCapture}
            onFramed={onFramed}
            onHighlightClick={onHighlightClick}
            onPainted={onLayoutTick}
          />
        );
      })}
      {dims.length === 0 && (
        <div className="grid h-64 place-items-center text-sm text-neutral-400">
          Loading original pages…
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- one page */

interface PdfPageProps {
  doc: PDFDocumentProxy | null;
  pageNo: number;
  width: number;
  aspect: number;
  crop: CropBox | null;
  scale: number;
  pageRow: DocumentTextRow | null;
  targets: OverlayTarget[];
  regions: PdfRegion[];
  captureMode: boolean;
  onCapture?: (pageNo: number, rect: CapturedRect, dataUrl: string, color: string) => void;
  onFramed?: () => void;
  onHighlightClick: (id: string) => void;
  onPainted?: () => void;
}

const PdfPage = memo(function PdfPage({
  doc,
  pageNo,
  width,
  aspect,
  crop,
  scale,
  pageRow,
  targets,
  regions,
  captureMode,
  onCapture,
  onFramed,
  onHighlightClick,
  onPainted,
}: PdfPageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [layerReady, setLayerReady] = useState(0);
  const [links, setLinks] = useState<PdfLinkRect[]>([]);
  const dprRef = useRef(1);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [pending, setPending] = useState<CapturedRect | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const onFramedRef = useRef(onFramed);
  onFramedRef.current = onFramed;
  // click-vs-drag discrimination for link anchors (fix: links block selection)
  const linkDownRef = useRef<{ x: number; y: number } | null>(null);

  // Escape abandons a framed-but-unconfirmed capture
  useEffect(() => {
    if (!pending && !drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPending(null);
        setDrag(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, drag]);

  // While a capture drag is active, move/up are tracked on WINDOW: a release
  // in the margin or outside the zoomport must finish the frame exactly like
  // an inside release (clamped to page bounds), never leave a dead rect.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const clampPoint = (e: MouseEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const r = wrap.getBoundingClientRect();
      return {
        x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
        y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
      };
    };
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      const p = clampPoint(e);
      if (!d || !p) return;
      setDrag({ ...d, x1: p.x, y1: p.y });
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = clampPoint(e);
      const x1 = p ? p.x : d.x1;
      const y1 = p ? p.y : d.y1;
      const rect = {
        x: Math.min(d.x0, x1),
        y: Math.min(d.y0, y1),
        w: Math.abs(x1 - d.x0),
        h: Math.abs(y1 - d.y0),
      };
      setDrag(null);
      if (rect.w > 16 && rect.h > 16) {
        setPending(rect);
        onFramedRef.current?.(); // rectangle fixed → arrow cursor comes back
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* render canvas + text layer */
  useEffect(() => {
    if (!doc || !visible) return;
    let cancelled = false;
    (async () => {
      const pdfjs = await loadPdfjs();
      const page = await doc.getPage(pageNo);
      if (cancelled) return;
      const vp1 = page.getViewport({ scale: 1 });
      // With a crop, the CONTENT (not the sheet) fills the column. The page
      // is rendered FULL SIZE at that scale on an inner "sheet"; the crop is
      // nothing but a CSS shift of the sheet inside the clipping wrapper, so
      // every layer keeps the battle-tested full-page geometry.
      const scale = crop ? width / crop.w : width / vp1.width;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const layer = layerRef.current;
      const sheet = sheetRef.current;
      if (!canvas || !layer || !sheet) return;

      sheet.style.width = `${viewport.width}px`;
      sheet.style.height = `${viewport.height}px`;
      sheet.style.left = crop ? `${-crop.x * scale}px` : "0px";
      sheet.style.top = crop ? `${-crop.y * scale}px` : "0px";

      // 1x rendering: pages are large after fit-width+crop, and 2x quadruples
      // the pixels — the jank outweighs the slightly softer glyph edges on
      // high-DPI screens. (Standard monitors are 1x anyway.)
      const dpr = 1;
      dprRef.current = dpr;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      await enqueueRender(
        () =>
          page.render({
            canvas,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          }).promise,
      );
      if (cancelled) return;

      layer.replaceChildren();
      layer.style.setProperty("--scale-factor", String(scale));
      layer.style.setProperty("--total-scale-factor", String(scale));
      const textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport,
      });
      await textLayer.render();
      const eoc = document.createElement("div");
      eoc.className = "endOfContent";
      layer.append(eoc);
      if (!cancelled) setLayerReady((v) => v + 1);

      // Link annotations → clickable rects. Computed with the SAME viewport
      // as the canvas/text layer, positioned in the sheet frame, so the crop
      // shift and zoom rerenders apply automatically (state is replaced
      // wholesale — no duplicates on rerender).
      try {
        const annots = (await page.getAnnotations({ intent: "display" })) as LinkAnnotationLike[];
        if (cancelled) return;
        const next: PdfLinkRect[] = [];
        annots.forEach((a, i) => {
          if (a.subtype !== "Link") return;
          // a.url is sanitized by pdf.js; unsafeUrl is not — only accept it
          // on known-safe schemes (a hostile PDF could carry javascript:).
          const url =
            a.url ??
            (a.unsafeUrl && /^(https?:|mailto:)/i.test(a.unsafeUrl) ? a.unsafeUrl : undefined);
          if (!url && !a.dest) return;
          if (!Array.isArray(a.rect) || a.rect.length < 4) return;
          // PDF-space rect corners → viewport space (same transform as the
          // canvas), then normalize: min/max is what convertToViewportRectangle
          // + Util.normalizeRect used to do.
          const p1 = viewport.convertToViewportPoint(a.rect[0], a.rect[1]) as number[];
          const p2 = viewport.convertToViewportPoint(a.rect[2], a.rect[3]) as number[];
          const left = Math.min(p1[0], p2[0]);
          const top = Math.min(p1[1], p2[1]);
          const w = Math.abs(p2[0] - p1[0]);
          const h = Math.abs(p2[1] - p1[1]);
          if (w <= 0 || h <= 0) return;
          next.push({
            key: a.id || `${pageNo}-link-${i}`,
            left,
            top,
            width: w,
            height: h,
            url,
            dest: a.dest,
          });
        });
        if (!cancelled) setLinks(next);
      } catch {
        if (!cancelled) setLinks([]);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, visible, pageNo, width, crop]);

  const onPaintedRef = useRef(onPainted);
  onPaintedRef.current = onPainted;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const targetsKey =
    targets.map((t) => `${t.id}:${t.color}:${t.start}:${t.end}:${t.active ? 1 : 0}`).join("|") +
    "||" +
    regions.map((r) => `${r.id}:${r.color}:${r.active ? 1 : 0}`).join("|");

  /* overlays: highlights + search hits over the original page */
  useEffect(() => {
    if (layerReady === 0 || !pageRow) return;
    const row = pageRow;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(paint);
    });
    function paint() {
    const layer = layerRef.current;
    const overlay = overlayRef.current;
    const wrap = wrapRef.current;
    if (!layer || !overlay || !wrap) return;

    overlay.replaceChildren();
    const spans = Array.from(layer.querySelectorAll<HTMLElement>("span"));
    if (spans.length === 0) return;

    // concatenated layer text + per-char span mapping
    let layerText = "";
    const charSpan: { span: HTMLElement; offset: number }[] = [];
    for (const span of spans) {
      const t = span.textContent ?? "";
      for (let i = 0; i < t.length; i++) charSpan.push({ span, offset: i });
      layerText += t;
      layerText += " ";
      charSpan.push({ span, offset: t.length });
    }
    const { norm: layerNorm, map: layerMap } = buildNormMap(layerText);
    // overlays live inside the shifted sheet: position them in ITS frame
    const originRect = overlay.getBoundingClientRect();

    const drawRange = (from: number, to: number, target: OverlayTarget) => {
      // group covered chars by span
      const bySpan = new Map<HTMLElement, { a: number; b: number }>();
      for (let n = from; n < to; n++) {
        const orig = layerMap[n];
        if (orig === undefined) continue;
        const cs = charSpan[orig];
        if (!cs) continue;
        const cur = bySpan.get(cs.span);
        if (!cur) bySpan.set(cs.span, { a: cs.offset, b: cs.offset + 1 });
        else {
          cur.a = Math.min(cur.a, cs.offset);
          cur.b = Math.max(cur.b, cs.offset + 1);
        }
      }
      const made: HTMLElement[] = [];
      for (const [span, r] of bySpan) {
        const len = (span.textContent ?? "").length || 1;
        const rect = span.getBoundingClientRect();
        // Exact glyph geometry: measure the [a,b) substring with a Range —
        // proportional character math drifts on variable-width/large fonts
        // (visible on titles). Falls back to proportional if measuring fails.
        let x = rect.left - originRect.left + (rect.width * r.a) / len;
        let w = (rect.width * (r.b - r.a)) / len;
        const textNode = span.firstChild;
        if (textNode?.nodeType === Node.TEXT_NODE && (textNode.textContent?.length ?? 0) >= r.b) {
          try {
            const range = document.createRange();
            range.setStart(textNode, r.a);
            range.setEnd(textNode, r.b);
            const rr = range.getBoundingClientRect();
            if (rr.width > 0) {
              x = rr.left - originRect.left;
              w = rr.width;
            }
          } catch {
            // keep the proportional fallback
          }
        }
        const div = document.createElement("div");
        div.className = "pdf-overlay";
        div.setAttribute("data-owner", target.id);
        div.style.left = `${x}px`;
        div.style.top = `${rect.top - originRect.top}px`;
        div.style.width = `${Math.max(2, w)}px`;
        div.style.height = `${rect.height}px`;
        div.style.background = OVERLAY_COLORS[target.color] ?? "rgba(240,201,86,0.4)";
        if (target.active) div.style.outline = "1.5px solid rgba(0,0,0,0.55)";
        if (!target.id.startsWith("s-")) {
          div.style.cursor = "pointer";
          div.style.pointerEvents = "auto";
          div.onclick = (e) => {
            e.stopPropagation();
            onHighlightClick(target.id);
          };
        }
        if (target.id.startsWith("s-") && target.color === "search-current") {
          div.classList.add("hl-search-current-marker");
        }
        overlay.appendChild(div);
        made.push(div);
      }
      if (made.length > 0) {
        made[0].setAttribute("data-hl", target.id);
        made[made.length - 1].setAttribute("data-hl", target.id);
      }
    };

    const { norm: storedNorm, map: storedMap } = buildNormMap(row.text);
    // inverse-ish lookup: stored original index -> stored norm index
    const origToNorm = new Map<number, number>();
    storedMap.forEach((orig, normIdx) => {
      if (!origToNorm.has(orig)) origToNorm.set(orig, normIdx);
    });
    const normAtOrAfter = (orig: number): number => {
      for (let i = orig; i < row.text.length; i++) {
        const n = origToNorm.get(i);
        if (n !== undefined) return n;
      }
      return storedNorm.length;
    };

    for (const target of targetsRef.current) {
      const localStart = Math.max(0, target.start - row.char_start);
      const localEnd = Math.min(row.text.length, target.end - row.char_start);
      const normStart = normAtOrAfter(localStart);
      const normEnd = normAtOrAfter(localEnd);
      const len = normEnd - normStart;
      if (len <= 0) continue;
      const layerIdx = mapStoredToLayer(layerNorm, storedNorm, normStart, len);
      if (layerIdx === -1) continue;
      drawRange(layerIdx, layerIdx + len, target);
    }

    // captured regions: coloured frames pinned to the page (sheet frame)
    for (const rg of regionsRef.current) {
      const div = document.createElement("div");
      div.className = "pdf-overlay";
      div.setAttribute("data-hl", rg.id);
      div.setAttribute("data-owner", rg.id);
      div.style.left = `${rg.x * scaleRef.current}px`;
      div.style.top = `${rg.y * scaleRef.current}px`;
      div.style.width = `${rg.w * scaleRef.current}px`;
      div.style.height = `${rg.h * scaleRef.current}px`;
      div.style.border = `2px solid ${REGION_COLORS[rg.color] ?? "#888"}`;
      div.style.borderRadius = "4px";
      div.style.background = REGION_FILL[rg.color] ?? "transparent";
      div.style.mixBlendMode = "multiply";
      if (rg.active) div.style.boxShadow = "0 0 0 2px rgba(0,0,0,0.35)";
      overlay.appendChild(div);
    }
    onPaintedRef.current?.();
    }
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerReady, targetsKey, pageRow]);

  /** Internal link: resolve the destination page and scroll to its wrapper —
   *  the same [data-page] + scrollIntoView mechanism the header Go-to-page
   *  uses (page wrappers are siblings inside PdfView's root, which lives in
   *  the reader's internal scroller). */
  const goToDest = useCallback(
    async (dest: string | unknown[]) => {
      if (!doc) return;
      try {
        const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
        if (!explicit || explicit.length === 0) return;
        const ref = explicit[0];
        const pageIndex =
          typeof ref === "number"
            ? ref
            : await doc.getPageIndex(ref as { num: number; gen: number });
        wrapRef.current?.parentElement
          ?.querySelector(`[data-page="${pageIndex + 1}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch {
        // unresolvable destination — ignore the click
      }
    },
    [doc],
  );

  /** Links navigate only on a CLEAN click: a drag (>3px between mousedown and
   *  mouseup) is a text selection, not a click, and a highlight overlay under
   *  the click point takes priority over the link (opens its thread). */
  const handleLinkClick = (e: ReactMouseEvent<HTMLAnchorElement>, l: PdfLinkRect) => {
    e.stopPropagation();
    const down = linkDownRef.current;
    linkDownRef.current = null;
    const sel = window.getSelection();
    if (
      (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) ||
      (sel && !sel.isCollapsed)
    ) {
      e.preventDefault(); // the gesture was a selection drag — no navigation
      return;
    }
    const owner = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          el.classList.contains("pdf-overlay") &&
          !!el.getAttribute("data-owner") &&
          !el.getAttribute("data-owner")!.startsWith("s-"),
      )
      ?.getAttribute("data-owner");
    if (owner) {
      e.preventDefault(); // highlight beneath the link wins: open its thread
      onHighlightClick(owner);
      return;
    }
    if (!l.url) {
      e.preventDefault();
      if (l.dest) void goToDest(l.dest);
    }
    // external links: fall through to the default target=_blank navigation
  };

  return (
    <div
      ref={wrapRef}
      data-page={pageNo}
      className="rd-pdf-page relative mb-5 overflow-hidden bg-white"
      style={{ width, height: width * aspect }}
      onPointerDown={() => {
        const layer = layerRef.current;
        if (!layer) return;
        layer.classList.add("selecting");
        window.addEventListener(
          "pointerup",
          () => layer.classList.remove("selecting"),
          { once: true },
        );
      }}
      onClick={(e) => {
        // open the thread of a clicked highlight (unless the user is selecting)
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const overlay = overlayRef.current;
        if (!overlay) return;
        for (const child of Array.from(overlay.children)) {
          const id = child.getAttribute("data-owner");
          if (!id || id.startsWith("s-")) continue;
          const r = child.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            onHighlightClick(id);
            return;
          }
        }
      }}
    >
      <div ref={sheetRef} className="absolute left-0 top-0">
        <canvas ref={canvasRef} className="absolute left-0 top-0" />
        <div ref={overlayRef} className="pointer-events-none absolute inset-0" />
        <div ref={layerRef} className="pdf-textlayer" />
        {/* link annotations: above canvas/text (z-10) but under the capture
            layer (z-40); only the rects themselves take pointer events, so
            text selection and highlight clicks keep working everywhere else */}
        {links.length > 0 && (
          <div className="pointer-events-none absolute inset-0 z-10">
            {links.map((l) =>
              l.url ? (
                <a
                  key={l.key}
                  data-testid="pdf-link"
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={l.url}
                  draggable={false}
                  onMouseDown={(e) => {
                    linkDownRef.current = { x: e.clientX, y: e.clientY };
                  }}
                  onClick={(e) => handleLinkClick(e, l)}
                  className="pointer-events-auto absolute block cursor-pointer rounded-[2px] hover:bg-black/[0.06] hover:shadow-[inset_0_-1px_0_rgba(0,0,0,0.35)]"
                  style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
                />
              ) : (
                <a
                  key={l.key}
                  data-testid="pdf-link"
                  href="#"
                  draggable={false}
                  onMouseDown={(e) => {
                    linkDownRef.current = { x: e.clientX, y: e.clientY };
                  }}
                  onClick={(e) => handleLinkClick(e, l)}
                  className="pointer-events-auto absolute block cursor-pointer rounded-[2px] hover:bg-black/[0.06] hover:shadow-[inset_0_-1px_0_rgba(0,0,0,0.35)]"
                  style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
                />
              ),
            )}
          </div>
        )}
      </div>

      {/* capture tool: crosshair drag layer */}
      {captureMode && (
        <div
          className="rd-capture-cursor absolute inset-0 z-40"
          onMouseDown={(e) => {
            const r = wrapRef.current!.getBoundingClientRect();
            const x = e.clientX - r.left;
            const y = e.clientY - r.top;
            setDrag({ x0: x, y0: y, x1: x, y1: y });
            setPending(null);
            e.preventDefault();
          }}
          // move/up handled on window while dragging — see the effect above
        >
          {drag && (
            <div
              className="absolute border-2 border-dashed border-neutral-800 bg-black/5"
              style={{
                left: Math.min(drag.x0, drag.x1),
                top: Math.min(drag.y0, drag.y1),
                width: Math.abs(drag.x1 - drag.x0),
                height: Math.abs(drag.y1 - drag.y0),
              }}
            />
          )}
        </div>
      )}

      {/* framed capture awaiting its colour */}
      {pending && (
        <div className="absolute z-40" style={{ left: pending.x, top: pending.y }}>
          <div
            className="border-2 border-dashed border-neutral-800 bg-black/5"
            style={{ width: pending.w, height: pending.h }}
          />
          {/* the colour palette opens IMMEDIATELY at the framed corner — no
              intermediate dot; its position is pre-clamped so the
              overflow-hidden page wrapper can NEVER clip it (rects at the
              bottom/left edges used to hide it = dead end) */}
          <div
            className="absolute"
            style={(() => {
              const PAL_W = 110; // 4×16px swatches + gaps + padding
              const PAL_H = 30;
              const M = 6;
              const pageH = width * aspect;
              // default: right-aligned to the corner, growing leftward
              let left = pending.w + 13 - PAL_W;
              // would overflow the page's left edge → anchor to the rect's
              // left edge growing rightward instead
              if (pending.x + left < M) left = 0;
              left = Math.min(Math.max(left, M - pending.x), width - PAL_W - M - pending.x);
              // default: just under the bottom-right corner; if that runs off
              // the page bottom, clamp up (above the corner / inside the rect)
              let top = pending.h - 9;
              top = Math.min(Math.max(top, M - pending.y), pageH - PAL_H - M - pending.y);
              return { left, top };
            })()}
          >
            <div className="flex items-center gap-1.5 rounded-full bg-black px-2 py-1.5 shadow-lg">
              {SWATCHES.map((sw) => (
                <button
                  key={sw.color}
                  aria-label={`Capture in ${sw.color}`}
                  title="Pick a colour — the chat about this area opens"
                  onClick={() => {
                    const canvas = canvasRef.current;
                    if (!canvas || !onCapture) return;
                    const dpr = dprRef.current;
                    const cropX = crop ? crop.x * scale : 0;
                    const cropY = crop ? crop.y * scale : 0;
                    const t = document.createElement("canvas");
                    t.width = Math.max(1, Math.round(pending.w * dpr));
                    t.height = Math.max(1, Math.round(pending.h * dpr));
                    const ctx = t.getContext("2d");
                    if (!ctx) return;
                    ctx.drawImage(
                      canvas,
                      (pending.x + cropX) * dpr,
                      (pending.y + cropY) * dpr,
                      pending.w * dpr,
                      pending.h * dpr,
                      0,
                      0,
                      t.width,
                      t.height,
                    );
                    const dataUrl = t.toDataURL("image/png");
                    setPending(null);
                    onCapture(
                      pageNo,
                      {
                        x: (pending.x + cropX) / scale,
                        y: (pending.y + cropY) / scale,
                        w: pending.w / scale,
                        h: pending.h / scale,
                      },
                      dataUrl,
                      sw.color,
                    );
                  }}
                  className="h-4 w-4 rounded-full transition-transform hover:scale-125"
                  style={{ background: sw.hex }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      <span className="absolute right-2 top-1 font-[family-name:var(--font-ui)] text-[10px] text-neutral-300">
        {pageNo}
      </span>
    </div>
  );
});

/* ------------------------------------------------------------ thumbnails */

export function PdfThumbnails({
  doc,
  count,
  currentPage,
  onSelect,
}: {
  doc: PDFDocumentProxy | null;
  count: number;
  currentPage: number;
  onSelect: (pageNo: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const btn = railRef.current?.querySelector<HTMLElement>(`[data-thumb="${currentPage}"]`);
    btn?.scrollIntoView({ block: "nearest" });
  }, [currentPage]);

  return (
    <div
      ref={railRef}
      className="flex h-full flex-col items-center gap-4 overflow-y-auto bg-neutral-100 px-4 py-5"
    >
      {Array.from({ length: count }, (_, i) => i + 1).map((pageNo) => (
        <button
          key={pageNo}
          data-thumb={pageNo}
          onClick={() => onSelect(pageNo)}
          className="flex flex-col items-center gap-1"
          aria-label={`Go to page ${pageNo}`}
          aria-current={pageNo === currentPage ? "page" : undefined}
        >
          <span
            className={`block w-20 overflow-hidden bg-white ${
              pageNo === currentPage
                ? "outline outline-2 outline-black"
                : "border border-neutral-300 hover:border-neutral-500"
            }`}
          >
            <ThumbCanvas doc={doc} pageNo={pageNo} />
          </span>
          <span
            className={`text-xs ${pageNo === currentPage ? "font-semibold text-black" : "text-neutral-500"}`}
          >
            {pageNo}
          </span>
        </button>
      ))}
    </div>
  );
}

const ThumbCanvas = memo(function ThumbCanvas({
  doc,
  pageNo,
}: {
  doc: PDFDocumentProxy | null;
  pageNo: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !visible) return;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNo);
      if (cancelled) return;
      const scale = 80 / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const canvas = ref.current;
      if (!canvas) return;
      canvas.width = Math.ceil(viewport.width * 2);
      canvas.height = Math.ceil(viewport.height * 2);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      await page.render({ canvas, viewport, transform: [2, 0, 0, 2, 0, 0] }).promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, visible, pageNo]);

  return <canvas ref={ref} className="block" style={{ minHeight: 90 }} />;
});
