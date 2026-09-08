"use client";

import { segmentParagraph, type HighlightSegmentSpec, type Paragraph } from "./offsets";

const DOT_COLORS: Record<string, string> = {
  amber: "#e0b446",
  green: "#5f9e5f",
  blue: "#5f83ac",
  rose: "#c06a76",
};

export interface ReaderElement {
  id: string;
  kind: "image" | "table";
  element_no: number;
  char_start: number;
  char_end: number;
  url: string | null;
  content_text: string | null;
}

interface ElementBlockProps {
  element: ReaderElement;
  para: Paragraph;
  specs: HighlightSegmentSpec[];
  activeId: string | null;
  onHighlightClick: (id: string) => void;
}

/**
 * A non-text element (image/table) in the reading flow. Carries an automatic
 * dot on its side: click → pick a colour → a thread opens about this element.
 */
export function ElementBlock({
  element,
  para,
  specs,
  activeId,
  onHighlightClick,
}: ElementBlockProps) {
  const covering = specs.find(
    (s) =>
      !s.id.startsWith("s-") && s.start <= element.char_start && s.end >= element.char_end,
  );
  const outline = covering ? DOT_COLORS[covering.color] : undefined;

  return (
    <figure className="group relative my-5 mr-8">
      {element.kind === "image" ? (
        element.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={element.url}
            alt={`Image ${element.element_no}`}
            className="max-h-[28rem] max-w-full border bg-white"
            style={{ borderColor: outline ?? "#e5e5e5", borderWidth: outline ? 2 : 1 }}
          />
        ) : (
          <div
            className="grid h-32 max-w-md place-items-center border border-dashed text-xs text-neutral-400"
            style={{ borderColor: outline ?? "#d4d4d4" }}
          >
            Image {element.element_no} (not embedded)
          </div>
        )
      ) : (
        <TableView content={element.content_text ?? ""} outline={outline} />
      )}

      {/* caption doubles as the element's text-layer anchor */}
      <figcaption>
        <p
          data-pstart={para.start}
          className="!mb-0 mt-1.5 font-[family-name:var(--font-ui)] !text-[11px] uppercase tracking-wider text-neutral-400"
        >
          {segmentParagraph(para, specs).map((seg, i) =>
            seg.highlightId ? (
              <mark
                key={i}
                data-hl={seg.highlightId}
                className={`hl hl-${seg.color} ${seg.highlightId === activeId ? "hl-active" : ""} cursor-pointer bg-transparent text-inherit`}
                onClick={(e) => {
                  if (seg.highlightId!.startsWith("s-")) return;
                  e.stopPropagation();
                  onHighlightClick(seg.highlightId!);
                }}
              >
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </p>
      </figcaption>

    </figure>
  );
}

function TableView({ content, outline }: { content: string; outline?: string }) {
  const rows = content
    .split("\n")
    .map((r) => r.split(" | "))
    .filter((r) => r.length > 0);
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <div
      className="max-w-full overflow-x-auto border bg-white"
      style={{ borderColor: outline ?? "#e5e5e5", borderWidth: outline ? 2 : 1 }}
    >
      <table className="w-full border-collapse font-[family-name:var(--font-ui)] text-[13px]">
        <thead>
          <tr>
            {head.map((c, i) => (
              <th
                key={i}
                className="border-b border-neutral-300 bg-neutral-50 px-2.5 py-1.5 text-left font-semibold text-neutral-800"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="border-b border-neutral-100 px-2.5 py-1.5 text-neutral-700">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
