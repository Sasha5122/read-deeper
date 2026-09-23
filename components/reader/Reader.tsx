"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentRow, DocumentTextRow, HighlightColor, HighlightWithThread, Plan, RegionWithThread } from "@/lib/types";
import { buildParagraphs } from "./offsets";
import { AiSearchDialog } from "./AiSearchDialog";
import { Connectors } from "./Connectors";
import { PageThumbnails } from "./PageThumbnails";
import type { ReaderElement } from "./ElementBlock";
import { PdfThumbnails, PdfView, type CapturedRect, type PdfSelection } from "./pdf/PdfView";
import { useRegions } from "./useRegions";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { RecentsPanel } from "./RecentsPanel";
import { SelectionToolbar } from "./SelectionToolbar";
import { TextLayer } from "./TextLayer";
import { ThreadCard } from "./ThreadCard";
import { UndoToast } from "./UndoToast";
import { useHighlights } from "./useHighlights";
import { useUndoDelete } from "./useUndoDelete";
import { useMarginLayout } from "./useMarginLayout";
import { useSelection } from "./useSelection";
import { stopIfStreaming, useThreads, type ThreadInput } from "./useThreads";

interface ReaderProps {
  document: DocumentRow;
  pages: DocumentTextRow[];
  initialHighlights: HighlightWithThread[];
  elements: ReaderElement[];
  initialRegions: RegionWithThread[];
  pdfUrl: string | null;
  userId: string;
  plan: Plan;
  /** document_ai.status — anything but "ready" shows the indexing badge. */
  aiPrepStatus?: string | null;
}

export function Reader({ document: doc, pages, initialHighlights, elements, initialRegions, pdfUrl, userId, plan, aiPrepStatus }: ReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const marginRef = useRef<HTMLDivElement>(null);

  const paragraphs = useMemo(() => buildParagraphs(pages), [pages]);
  const { highlights, setHighlights, create, error: hlError, clearError } =
    useHighlights(doc.id, initialHighlights);
  const { selection, clear: clearSelection } = useSelection(articleRef);
  const { regions, setRegions, createRegion, regionsError, clearRegionsError, retryLastRegion } =
    useRegions(doc.id, initialRegions);
  const { streamingThreadId, streamingText, send, sendNote, error: msgError, clearError: clearMsgError } =
    useThreads(setHighlights, setRegions);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [currentPage, setCurrentPage] = useState(pages[0]?.page_no ?? 1);
  const [containerHeight, setContainerHeight] = useState(0);
  const [textRight, setTextRight] = useState(0);
  const [searchQ, setSearchQ] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  const [aiOpen, setAiOpen] = useState(false);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [pdfSelection, setPdfSelection] = useState<PdfSelection | null>(null);
  // Zoom applies ONLY to the document column (chat margin stays put); the
  // overflowing page pans inside the zoomport via the sticky bottom bar.
  const [zoom, setZoom] = useState(1);
  const zoomportRef = useRef<HTMLDivElement>(null);
  const zoomBarRef = useRef<HTMLDivElement>(null);
  const panTickRef = useRef(false);
  const panDragRef = useRef<{ startX: number; startLeft: number } | null>(null);
  const [zoomPan, setZoomPan] = useState({ left: 0, view: 0, content: 0 });
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [overlayTick, setOverlayTick] = useState(0);
  const savedScrollRef = useRef<number | null>(null);
  const [captureMode, setCaptureMode] = useState(false);
  const [captureArming, setCaptureArming] = useState(false);
  const armPendingRef = useRef(false);

  // Two-step activation: the FIRST commit only turns the button black with a
  // spinner (tiny, paints immediately); the heavy captureMode render starts a
  // frame later, while the spinner keeps animating on the compositor.
  function toggleCapture() {
    if (captureMode || captureArming) {
      armPendingRef.current = false;
      setCaptureArming(false);
      setCaptureMode(false);
      return;
    }
    armPendingRef.current = true;
    setCaptureArming(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (armPendingRef.current) setCaptureMode(true);
      });
    });
  }
  // spinner stays until the crosshair layers have actually painted
  useEffect(() => {
    if (!captureMode) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setCaptureArming(false));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [captureMode]);

  // --- classic in-text search ---
  const fullTextLower = useMemo(() => pages.map((pg) => pg.text).join("").toLowerCase(), [pages]);
  const query = searchQ.trim().toLowerCase();
  const matches = useMemo(() => {
    if (query.length < 2) return [];
    const out: number[] = [];
    let i = fullTextLower.indexOf(query);
    while (i !== -1 && out.length < 300) {
      out.push(i);
      i = fullTextLower.indexOf(query, i + query.length);
    }
    return out;
  }, [query, fullTextLower]);
  useEffect(() => setSearchIdx(0), [query]);
  useEffect(() => {
    if (matches.length === 0) return;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const jump = () => {
      const el = articleRef.current?.querySelector(
        ".hl-search-current, .hl-search-current-marker",
      );
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      }
      return false;
    };
    requestAnimationFrame(() => {
      if (jump()) return;
      // marker not painted yet (virtualised page): go to its page, retry
      const offset = matches[searchIdx];
      const page = pages.find((pg) => offset >= pg.char_start && offset < pg.char_end);
      if (page) {
        articleRef.current
          ?.querySelector(`[data-page="${page.page_no}"]`)
          ?.scrollIntoView({ block: "start" });
      }
      retry = setTimeout(jump, 800);
    });
    return () => {
      if (retry) clearTimeout(retry);
    };
  }, [matches, searchIdx, pages]);
  const searchSpecs = matches.map((m, i) => ({
    id: `s-${i}`,
    color: i === searchIdx ? "search-current" : "search-hit",
    start: m,
    end: m + query.length,
  }));
  const stepSearch = (dir: 1 | -1) => {
    if (matches.length > 0) setSearchIdx((i) => (i + dir + matches.length) % matches.length);
  };

  const pageStartByNo = useMemo(
    () => new Map(pages.map((pg) => [pg.page_no, pg.char_start])),
    [pages],
  );
  const regionItems: HighlightWithThread[] = useMemo(
    () =>
      regions.map((r) => {
        const base = (pageStartByNo.get(r.page_no) ?? 0) + Math.max(0, Math.round(r.y));
        return {
          id: r.id,
          document_id: r.document_id,
          user_id: r.user_id,
          char_start: base,
          char_end: base + 1,
          quote: "[captured area]",
          prefix: "",
          suffix: "",
          color: r.color,
          created_at: r.created_at,
          thread: r.thread,
        };
      }),
    [regions, pageStartByNo],
  );
  const allItems = useMemo(
    () => [...highlights, ...regionItems].sort((a, b) => a.char_start - b.char_start),
    [highlights, regionItems],
  );
  const regionIds = useMemo(() => new Set(regions.map((r) => r.id)), [regions]);
  const pdfRegions = useMemo(
    () =>
      regions.map((r) => ({
        id: r.id,
        color: r.color,
        page_no: r.page_no,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        active: r.id === activeId,
      })),
    [regions, activeId],
  );

  // --- delayed delete with undo (both ✕ paths go through here) ---
  // The item leaves the UI immediately (optimistic, same visual result as
  // before) but the server DELETE waits UNDO_WINDOW_MS; Undo just puts the
  // stashed item back — nothing was deleted yet, so no server call is needed.
  const { pendingId: undoPendingId, scheduleDelete, undo: undoDelete } = useUndoDelete();
  const deleteItem = useCallback(
    (id: string) => {
      setActiveId(null);
      if (regionIds.has(id)) {
        const item = regions.find((r) => r.id === id);
        if (!item) return;
        // Deleting the streaming card must stop its stream exactly like the
        // Stop button, or busy stays true for the whole orphaned generation.
        stopIfStreaming(item.thread?.id);
        setRegions((prev) => prev.filter((r) => r.id !== id));
        scheduleDelete({
          id,
          url: `/api/regions/${id}`,
          restore: () => {
            setRegions((prev) => (prev.some((r) => r.id === id) ? prev : [...prev, item]));
            setOverlayTick((t) => t + 1); // re-anchor cards/connectors
          },
        });
      } else {
        const item = highlights.find((h) => h.id === id);
        if (!item) return;
        stopIfStreaming(item.thread?.id);
        setHighlights((prev) => prev.filter((h) => h.id !== id));
        scheduleDelete({
          id,
          url: `/api/highlights/${id}`,
          restore: () => {
            setHighlights((prev) =>
              prev.some((h) => h.id === id)
                ? prev
                : [...prev, item].sort((a, b) => a.char_start - b.char_start),
            );
            setOverlayTick((t) => t + 1); // re-anchor cards/connectors
          },
        });
      }
    },
    [regionIds, regions, highlights, setRegions, setHighlights, scheduleDelete],
  );

  const totalMessages = allItems.reduce((n, h) => n + (h.thread?.messages.length ?? 0), 0);
  const layoutEpoch = totalMessages * 100000 + streamingText.length + overlayTick * 131;
  const { positions } = useMarginLayout(containerRef, allItems, activeId, layoutEpoch);

  // --- responsive + geometry ---
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      setContainerHeight(container.scrollHeight);
      const article = articleRef.current;
      if (article) setTextRight(article.offsetLeft + article.offsetWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // --- track the page currently in view (drives the thumbnail rail) ---
  useEffect(() => {
    const root = scrollRef.current;
    const article = articleRef.current;
    if (!root || !article) return;
    const sections = article.querySelectorAll<HTMLElement>("[data-page]");
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const no = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) visible.add(no);
          else visible.delete(no);
        }
        if (visible.size > 0) setCurrentPage(Math.min(...visible));
      },
      { root, threshold: 0 },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
    // pdfDoc/overlayTick: PDF page wrappers mount asynchronously after load —
    // re-attach the observer once they exist, else the indicator sticks at 1.
  }, [paragraphs, pdfDoc, overlayTick]);

  function goToPage(pageNo: number) {
    articleRef.current
      ?.querySelector(`[data-page="${pageNo}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // --- persist scroll position + last active thread per document (UI state) ---
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`rd-pos-${doc.id}`);
      if (raw) {
        const saved = JSON.parse(raw) as { scrollTop?: number; activeId?: string | null };
        if (saved.activeId) setActiveId(saved.activeId);
        if (saved.scrollTop) {
          savedScrollRef.current = saved.scrollTop;
          requestAnimationFrame(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = saved.scrollTop!;
          });
        }
      }
    } catch {
      // Storage unavailable — start at the top.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      try {
        localStorage.setItem(
          `rd-pos-${doc.id}`,
          JSON.stringify({ scrollTop: root.scrollTop, activeId }),
        );
      } catch {
        // Best effort only.
      }
    };
    const onScroll = () => {
      if (t) clearTimeout(t);
      t = setTimeout(save, 250);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    save();
    return () => {
      if (t) clearTimeout(t);
      root.removeEventListener("scroll", onScroll);
    };
  }, [doc.id, activeId]);

  // pdf pages get their height only after the document loads — re-apply the
  // remembered scroll position once, or the session opens at the top
  useEffect(() => {
    if (!pdfDoc || savedScrollRef.current === null) return;
    const target = savedScrollRef.current;
    const t = setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = target;
      savedScrollRef.current = null;
    }, 350);
    return () => clearTimeout(t);
  }, [pdfDoc]);

  // --- provider cache keep-warm: pre-heat on open, ping while visible ---
  // A warm ping costs ~$0.002; one avoided cold start saves ~7x that, and the
  // FIRST question of a session also lands on a hot cache.
  useEffect(() => {
    let stopped = false;
    const warm = () => {
      if (stopped || document.visibilityState !== "visible") return;
      void fetch(`/api/documents/${doc.id}/warm`, { method: "POST" }).catch(() => {});
    };
    warm();
    const iv = setInterval(warm, 4 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState === "visible") warm();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [doc.id]);

  // --- keyboard: ONE Escape handler, topmost layer only ---
  // Hierarchy: (a) AI search dialog and (b) Recents dropdown / New-session
  // dialog each own their Escape via their own window listeners — while any
  // of them is up (DOM check, robust to listener order within the same
  // keydown) this handler does NOTHING, so one Esc closes exactly one layer.
  // Then: (c) cancel an armed/framed capture, (d) dismiss the selection
  // palette, (e) collapse the active thread card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector('[data-testid="aisearch-dialog"]') || // (a) closes itself
        document.querySelector('[role="dialog"]') || // (b) New-session dialog closes itself
        document.querySelector('[aria-expanded="true"]') || // (b) Recents dropdown closes itself
        document.querySelector('button[aria-label^="Capture in"]') // framed palette lives in PdfView
      ) {
        return;
      }
      if (captureMode || captureArming) {
        // (c) cancel capture
        armPendingRef.current = false;
        setCaptureArming(false);
        setCaptureMode(false);
        return;
      }
      if (pdfUrl ? pdfSelection : selection) {
        // (d) dismiss the selection palette
        clearSelection();
        setPdfSelection(null);
        return;
      }
      setActiveId(null); // (e) collapse the active card
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureMode, captureArming, pdfUrl, pdfSelection, selection, clearSelection]);

  // --- zoom (document column only) ---
  const ZOOM_STEPS = [1, 1.25, 1.5, 1.75, 2, 2.5];

  const applyZoom = useCallback(
    (z: number) => {
      setZoom(z);
      try {
        localStorage.setItem(`rd-zoom-${doc.id}`, String(z));
      } catch {}
      if (z === 1 && zoomportRef.current) zoomportRef.current.scrollLeft = 0;
    },
    [doc.id],
  );
  // Functional update: two rapid clicks must step twice (a closure over `zoom`
  // would make both see the same stale value and only step once).
  const stepZoom = useCallback(
    (dir: 1 | -1) =>
      setZoom((prev) => {
        const i = ZOOM_STEPS.findIndex((s) => Math.abs(s - prev) < 0.01);
        const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i === -1 ? 0 : i) + dir))];
        try {
          localStorage.setItem(`rd-zoom-${doc.id}`, String(next));
        } catch {}
        if (next === 1 && zoomportRef.current) zoomportRef.current.scrollLeft = 0;
        return next;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.id],
  );

  // Ctrl + wheel (and trackpad pinch, which browsers deliver as ctrl+wheel)
  // zooms the document column with the SAME steps/clamps as the −/+ buttons.
  // Listener lives on the zoomport only, so the margin/chat column never
  // zooms; non-passive because preventDefault must block the browser's own
  // page zoom. Plain wheel (no ctrl) is untouched — normal scroll.
  const wheelAccRef = useRef(0);
  useEffect(() => {
    const zp = zoomportRef.current;
    if (!zp) return;
    const WHEEL_STEP = 50; // deltaY per zoom step — trackpads emit tiny deltas in bursts
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Direction change discards the leftover, so reversing reacts instantly.
      if (wheelAccRef.current !== 0 && Math.sign(e.deltaY) !== Math.sign(wheelAccRef.current)) {
        wheelAccRef.current = 0;
      }
      wheelAccRef.current += e.deltaY;
      if (Math.abs(wheelAccRef.current) >= WHEEL_STEP) {
        stepZoom(wheelAccRef.current < 0 ? 1 : -1); // wheel up / pinch out = zoom in
        wheelAccRef.current = 0; // one step per crossing — a mouse notch (±100) steps once
      }
    };
    zp.addEventListener("wheel", onWheel, { passive: false });
    return () => zp.removeEventListener("wheel", onWheel);
  }, [pdfUrl, stepZoom]);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(`rd-zoom-${doc.id}`));
      if (saved && ZOOM_STEPS.includes(saved)) setZoom(saved);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  // Pan-bar geometry mirrors the zoomport (custom thumb: native scrollbars
  // are unreliable to render, especially with overlay-scrollbar settings).
  const refreshPan = useCallback(() => {
    const zp = zoomportRef.current;
    if (!zp) return;
    setZoomPan({ left: zp.scrollLeft, view: zp.clientWidth, content: zp.scrollWidth });
  }, []);
  useEffect(() => {
    refreshPan();
  }, [zoom, overlayTick, pdfDoc, refreshPan]);

  /** Zoomport scrolled: update the thumb + live re-anchor cards/connectors. */
  const onPan = () => {
    if (panTickRef.current) return;
    panTickRef.current = true;
    requestAnimationFrame(() => {
      panTickRef.current = false;
      refreshPan();
      setOverlayTick((t) => t + 1);
    });
  };

  const panScrollable = Math.max(0, zoomPan.content - zoomPan.view);
  const panTrackW = zoomPan.view; // the bar spans the document column
  const panThumbW =
    zoomPan.content > 0 ? Math.max(40, (zoomPan.view / zoomPan.content) * panTrackW) : 0;
  const panThumbLeft =
    panScrollable > 0 ? (zoomPan.left / panScrollable) * Math.max(0, panTrackW - panThumbW) : 0;

  const onThumbPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const zp = zoomportRef.current;
    if (!zp) return;
    panDragRef.current = { startX: e.clientX, startLeft: zp.scrollLeft };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onThumbPointerMove = (e: React.PointerEvent) => {
    const d = panDragRef.current;
    const zp = zoomportRef.current;
    if (!d || !zp) return;
    const usable = Math.max(1, panTrackW - panThumbW);
    zp.scrollLeft = d.startLeft + (e.clientX - d.startX) * (panScrollable / usable);
  };
  const onThumbPointerUp = () => {
    panDragRef.current = null;
  };
  const onTrackPointerDown = (e: React.PointerEvent) => {
    const zp = zoomportRef.current;
    const bar = zoomBarRef.current;
    if (!zp || !bar || e.target !== bar) return;
    const rect = bar.getBoundingClientRect();
    const usable = Math.max(1, panTrackW - panThumbW);
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left - panThumbW / 2) / usable));
    zp.scrollLeft = ratio * panScrollable;
  };

  // --- actions ---
  const activeSelection = pdfUrl ? pdfSelection : selection;

  function clearAnySelection() {
    clearSelection();
    setPdfSelection(null);
  }

  // Selection palette lifetime: a click anywhere outside it dismisses the
  // selection immediately; left untouched it expires after 10 seconds.
  useEffect(() => {
    if (!activeSelection) return;
    const timer = setTimeout(() => {
      clearSelection();
      setPdfSelection(null);
    }, 10_000);
    const onDown = (e: MouseEvent | TouchEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("[data-seltoolbar]")) return;
      clearSelection();
      setPdfSelection(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
    };
  }, [activeSelection, clearSelection]);

  async function askSelection(chosen: HighlightColor) {
    if (!activeSelection || creating) return;
    setCreating(true);
    try {
      const item = await create(activeSelection.start, activeSelection.end, chosen);
      setActiveId(item.id);
      clearAnySelection();
    } catch {
      // error already surfaced by the hook
    } finally {
      setCreating(false);
    }
  }

  async function handleCapture(
    pageNo: number,
    rect: CapturedRect,
    dataUrl: string,
    color: string,
  ) {
    setCaptureMode(false);
    try {
      const item = await createRegion({
        pageNo,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        color: color as HighlightColor,
        image: dataUrl,
      });
      setActiveId(item.id);
    } catch {
      // error surfaced by the hook
    }
  }

  function sendTo(threadId: string) {
    return (input: ThreadInput, shown: string) => void send(threadId, input, shown);
  }

  // --- unified error banner: one dismissible bar for all three sources ---
  const shownError = hlError ?? msgError ?? regionsError;
  const dismissShownError = useCallback(() => {
    // Clear the SOURCE currently shown (same precedence as shownError).
    if (hlError) clearError();
    else if (msgError) clearMsgError();
    else clearRegionsError();
  }, [hlError, msgError, clearError, clearMsgError, clearRegionsError]);
  // Auto-dismiss 8s after each NEW error (timer restarts when the text changes).
  useEffect(() => {
    if (!shownError) return;
    const t = setTimeout(dismissShownError, 8000);
    return () => clearTimeout(t);
  }, [shownError, dismissShownError]);
  // The failed capture kept its PNG (useRegions.lastFailed) — offer a Retry.
  const showCaptureRetry =
    !hlError && !msgError && !!regionsError && /couldn't save the capture/i.test(regionsError);

  // --- scanned-PDF notice: original pages but (almost) no selectable text ---
  const isScannedPdf = useMemo(
    () =>
      doc.kind === "pdf" &&
      !!pdfUrl &&
      pages.length > 0 &&
      pages.reduce((n, p) => n + p.text.trim().length, 0) / pages.length < 20,
    [doc.kind, pdfUrl, pages],
  );
  const [scanNoticeDismissed, setScanNoticeDismissed] = useState(false);

  const active = allItems.find((h) => h.id === activeId) ?? null;
  const specs = highlights.map((h) => ({
    id: h.id,
    color: h.color,
    start: h.char_start,
    end: h.char_end,
  }));

  return (
    <div className="flex h-screen flex-col bg-neutral-100 text-black">
      <header className="z-30 border-b border-neutral-200 bg-white">
        <div className="flex items-center gap-3 px-4 py-2">
          <RecentsPanel currentDocId={doc.id} userId={userId} plan={plan} />
          <h1 className="min-w-0 max-w-[22rem] truncate font-[family-name:var(--font-display)] text-[15px] font-semibold">
            {doc.title}
          </h1>
          {aiPrepStatus !== undefined && aiPrepStatus !== "ready" && (
            <span
              data-testid="aiprep-badge"
              title="The AI index for this document is still being built — answers work meanwhile, and get sharper once it finishes."
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-[family-name:var(--font-ui)] text-[11px] text-neutral-500"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400" />
              indexing…
            </span>
          )}

          {!isMobile && (
            <div className="flex min-w-0 shrink items-center gap-2.5">
              {/* search */}
              <div className="flex items-center gap-1 rounded-lg border border-neutral-300 bg-neutral-50 px-2 py-1 focus-within:border-neutral-500 focus-within:bg-white">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-neutral-400" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                <input
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") stepSearch(e.shiftKey ? -1 : 1);
                    if (e.key === "Escape" && searchQ) {
                      // First Esc only clears the query — don't let the window
                      // hierarchy also act on the same keypress.
                      e.stopPropagation();
                      setSearchQ("");
                    }
                  }}
                  placeholder="Search in text"
                  className="w-36 bg-transparent text-xs text-neutral-800 outline-none placeholder:text-neutral-400"
                />
                {query.length >= 2 && (
                  <>
                    <span className="text-[11px] tabular-nums text-neutral-400">
                      {matches.length === 0 ? "0/0" : `${searchIdx + 1}/${matches.length}`}
                    </span>
                    <button onClick={() => stepSearch(-1)} aria-label="Previous match" className="px-0.5 text-neutral-400 hover:text-black">&#8249;</button>
                    <button onClick={() => stepSearch(1)} aria-label="Next match" className="px-0.5 text-neutral-400 hover:text-black">&#8250;</button>
                  </>
                )}
              </div>

              {/* AI semantic search */}
              <button
                onClick={() => setAiOpen(true)}
                title="Describe in your own words what you're looking for — AI finds the place"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-neutral-300 px-2.5 text-xs font-medium text-neutral-600 transition-colors hover:border-neutral-800 hover:text-black"
              >
                <span aria-hidden="true">✦</span>
                AI search
              </button>

              {pdfUrl && (
                <button
                  onClick={toggleCapture}
                  aria-label="Capture area tool"
                  title="Capture an area: frame it, pick a colour, a chat opens about it"
                  className={`flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium ${
                    captureMode || captureArming
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-300 text-neutral-600 hover:border-neutral-800 hover:text-black"
                  }`}
                >
                  {captureArming ? (
                    <span
                      className="block h-[12px] w-[12px] animate-spin rounded-full border-2 border-neutral-600 border-t-white"
                      aria-hidden="true"
                    />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
                    </svg>
                  )}
                  {captureMode || captureArming ? "Draw a box" : "Capture"}
                </button>
              )}

              {pdfUrl && (
                <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-neutral-300">
                  <button
                    onClick={() => stepZoom(-1)}
                    aria-label="Zoom out"
                    className="h-full px-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-black"
                  >
                    −
                  </button>
                  <button
                    onClick={() => applyZoom(1)}
                    title="Reset zoom"
                    className="h-full min-w-[3rem] px-1 text-[11px] tabular-nums text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-black"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    onClick={() => stepZoom(1)}
                    aria-label="Zoom in"
                    className="h-full px-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-black"
                  >
                    +
                  </button>
                </div>
              )}

              <a
                href={`/api/documents/${doc.id}/export`}
                title="Export threads as Markdown"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-neutral-300 text-sm text-neutral-500 transition-colors hover:border-neutral-800 hover:text-black"
              >
                ⤓
              </a>

              <span className="h-5 w-px bg-neutral-200" />

              {/* page position + go to page */}
              <div className="flex items-center gap-1 text-xs text-neutral-600">
                <span>Page</span>
                <input
                  value={pageDraft ?? String(currentPage)}
                  onFocus={(e) => {
                    setPageDraft(String(currentPage));
                    e.target.select();
                  }}
                  onBlur={() => setPageDraft(null)}
                  onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const n = Number(pageDraft);
                      if (n >= 1 && n <= pages.length) goToPage(n);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  aria-label="Go to page"
                  className="w-10 rounded-md border border-neutral-300 bg-neutral-50 px-1 py-0.5 text-center text-xs tabular-nums text-neutral-800 outline-none focus:border-neutral-500 focus:bg-white"
                />
                <span className="whitespace-nowrap">of {pages.length}</span>
              </div>

            </div>
          )}
        </div>
        {shownError && (
          <div className="flex items-center gap-3 border-t border-neutral-200 bg-neutral-50 px-4 py-1.5 text-sm text-red-700">
            <span className="min-w-0 flex-1 truncate" title={shownError}>
              {shownError}
            </span>
            {showCaptureRetry && (
              <button
                data-testid="capture-retry"
                onClick={() => void retryLastRegion()}
                className="shrink-0 font-semibold underline"
              >
                Retry
              </button>
            )}
            <button
              onClick={dismissShownError}
              aria-label="Dismiss error"
              className="shrink-0 px-1 font-semibold text-red-700/70 transition-colors hover:text-red-900"
            >
              ✕
            </button>
          </div>
        )}
      </header>

      {isScannedPdf && !scanNoticeDismissed && (
        <div
          data-testid="scanned-banner"
          className="flex items-center gap-3 border-b border-amber-200/80 bg-amber-50 px-4 py-1.5 text-xs text-amber-900"
        >
          <span className="min-w-0 flex-1">
            This PDF is a scan — text can&rsquo;t be selected. Use the Capture tool to ask about
            any area.
          </span>
          <button
            onClick={() => setScanNoticeDismissed(true)}
            aria-label="Dismiss notice"
            className="shrink-0 px-1 text-amber-900/60 transition-colors hover:text-amber-900"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Page thumbnails */}
        {!isMobile && (
          <aside className="w-40 shrink-0 border-r border-neutral-200">
            {pdfUrl ? (
              <PdfThumbnails
                doc={pdfDoc}
                count={pages.length}
                currentPage={currentPage}
                onSelect={goToPage}
              />
            ) : (
              <PageThumbnails pages={pages} currentPage={currentPage} onSelect={goToPage} />
            )}
          </aside>
        )}

        {/* Scrollable reading area: text 60% / threads 40% */}
        <div
          ref={scrollRef}
          className={`min-w-0 flex-1 overflow-y-auto ${
            pdfUrl && (captureMode || captureArming) ? "rd-capture-cursor" : ""
          }`}
        >
          <div ref={containerRef} className="relative flex items-start px-5 py-6">
            {!isMobile && (
              <Connectors
                positions={positions}
                colorById={Object.fromEntries(allItems.map((h) => [h.id, h.color]))}
                activeId={activeId}
                textRight={textRight}
                height={containerHeight}
              />
            )}

            <div
              ref={articleRef}
              className={
                isMobile ? "min-w-0 flex-1" : pdfUrl ? "min-w-0 flex-1" : "w-[60%] min-w-0"
              }
            >
              {pdfUrl ? (
                <>
                  <div
                    ref={zoomportRef}
                    onScroll={onPan}
                    className="rd-zoomport"
                    style={{ overflowX: zoom > 1 ? "auto" : "visible" }}
                  >
                    <PdfView
                      url={pdfUrl}
                      pages={pages}
                      highlights={specs}
                      searchSpecs={searchSpecs}
                      activeId={activeId}
                      onHighlightClick={setActiveId}
                      onTextSelected={setPdfSelection}
                      onDocLoaded={setPdfDoc}
                      onLayoutTick={() => setOverlayTick((t) => t + 1)}
                      regions={pdfRegions}
                      captureMode={captureMode}
                      onCapture={(pageNo, rect, dataUrl, color) =>
                        void handleCapture(pageNo, rect, dataUrl, color)
                      }
                      onFramed={() => {
                        armPendingRef.current = false;
                        setCaptureArming(false);
                        setCaptureMode(false);
                      }}
                      zoom={zoom}
                    />
                  </div>
                  {/* Sticky pan bar: custom track+thumb (always visibly rendered),
                      pinned to the bottom of the viewport while reading. */}
                  {zoom > 1 && panScrollable > 2 && (
                    <div
                      ref={zoomBarRef}
                      data-testid="zoom-panbar"
                      onPointerDown={onTrackPointerDown}
                      className="sticky bottom-1.5 z-30 mt-2 h-3 cursor-pointer rounded-full border border-[#d9d6cc] bg-[#e9e7e0] shadow-sm"
                    >
                      <div
                        data-testid="zoom-thumb"
                        onPointerDown={onThumbPointerDown}
                        onPointerMove={onThumbPointerMove}
                        onPointerUp={onThumbPointerUp}
                        className="absolute top-0 h-full rounded-full bg-neutral-500 transition-colors hover:bg-neutral-700"
                        style={{ left: panThumbLeft, width: panThumbW }}
                      />
                    </div>
                  )}
                </>
              ) : (
                <TextLayer
                  paragraphs={paragraphs}
                  highlights={specs}
                  searchSpecs={searchSpecs}
                  elements={elements}
                  activeId={activeId}
                  onHighlightClick={setActiveId}
                />
              )}
            </div>

            {/* Chat margin (desktop) */}
            {!isMobile && (
              <div
                ref={marginRef}
                data-margin-col
                className={`relative z-20 shrink-0 self-stretch ${pdfUrl ? "w-[27.5rem]" : "w-[40%]"}`}
              >
                {allItems.map((h) => {
                  const pos = positions.get(h.id);
                  return (
                    <ThreadCard
                      key={h.id}
                      highlight={h}
                      expanded={h.id === activeId}
                      streamingText={streamingThreadId === h.thread?.id ? streamingText : null}
                      busy={streamingThreadId !== null}
                      onActivate={() => setActiveId(h.id)}
                      onCollapse={() => setActiveId(null)}
                      onSend={h.thread ? sendTo(h.thread.id) : () => {}}
                      onSaveNote={(c) => {
                        if (h.thread) void sendNote(h.thread.id, c);
                      }}
                      onDelete={() => deleteItem(h.id)}
                      style={{ top: pos?.cardTop ?? 0, visibility: pos ? "visible" : "hidden" }}
                    />
                  );
                })}
              </div>
            )}

            {/* Mobile: dot markers in the right gutter */}
            {isMobile && (
              <div className="pointer-events-none absolute inset-y-0 right-0 w-4">
                {allItems.map((h) => {
                  const pos = positions.get(h.id);
                  if (!pos) return null;
                  return (
                    <button
                      key={h.id}
                      onClick={() => setActiveId(h.id)}
                      className="pointer-events-auto absolute h-3 w-3 rounded-full border border-white shadow"
                      style={{
                        top: pos.anchorY,
                        background:
                          { amber: "#e0b446", green: "#5f9e5f", blue: "#5f83ac", rose: "#c06a76" }[
                            h.color
                          ],
                      }}
                      aria-label="Open thread"
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mobile: active thread as a bottom sheet */}
      {isMobile && active && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white p-3 shadow-2xl">
          <ThreadCard
            highlight={active}
            expanded
            asSheet
            streamingText={streamingThreadId === active.thread?.id ? streamingText : null}
            busy={streamingThreadId !== null}
            onActivate={() => {}}
            onCollapse={() => setActiveId(null)}
            onSend={active.thread ? sendTo(active.thread.id) : () => {}}
            onSaveNote={(c) => {
              if (active.thread) void sendNote(active.thread.id, c);
            }}
            onDelete={() => deleteItem(active.id)}
          />
        </div>
      )}

      <AiSearchDialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        documentId={doc.id}
        onGoToPage={goToPage}
        pageCount={pages.length}
      />

      {/* Delayed-delete toast — keyed by the pending id so a second delete
          remounts it and restarts the countdown strip. */}
      {undoPendingId && <UndoToast key={undoPendingId} onUndo={undoDelete} />}


      {activeSelection && (
        <SelectionToolbar
          rect={activeSelection.rect}
          scrollEl={scrollRef.current}
          busy={creating}
          onPick={(c) => void askSelection(c)}
        />
      )}
    </div>
  );
}
