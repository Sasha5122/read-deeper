"use client";

import { memo, useEffect, useRef } from "react";
import type { DocumentTextRow } from "@/lib/types";

interface PageThumbnailsProps {
  pages: DocumentTextRow[];
  currentPage: number;
  onSelect: (pageNo: number) => void;
}

/** PDF-viewer-style page selector: mini previews with page numbers. */
export const PageThumbnails = memo(function PageThumbnails({
  pages,
  currentPage,
  onSelect,
}: PageThumbnailsProps) {
  const railRef = useRef<HTMLDivElement>(null);

  // Keep the current page's thumbnail in view as the user scrolls the text.
  useEffect(() => {
    const btn = railRef.current?.querySelector<HTMLElement>(`[data-thumb="${currentPage}"]`);
    btn?.scrollIntoView({ block: "nearest" });
  }, [currentPage]);

  return (
    <div
      ref={railRef}
      className="flex h-full flex-col items-center gap-4 overflow-y-auto bg-neutral-100 px-4 py-5"
    >
      {pages.map((p) => {
        const selected = p.page_no === currentPage;
        return (
          <button
            key={p.page_no}
            data-thumb={p.page_no}
            onClick={() => onSelect(p.page_no)}
            className="flex flex-col items-center gap-1"
            aria-label={`Go to page ${p.page_no}`}
            aria-current={selected ? "page" : undefined}
          >
            <span
              className={`block h-28 w-20 overflow-hidden bg-white p-1.5 ${
                selected
                  ? "outline outline-2 outline-black"
                  : "border border-neutral-300 hover:border-neutral-500"
              }`}
            >
              <span className="thumb-preview block" aria-hidden="true">
                {p.text.slice(0, 700)}
              </span>
            </span>
            <span
              className={`text-xs ${selected ? "font-semibold text-black" : "text-neutral-500"}`}
            >
              {p.page_no}
            </span>
          </button>
        );
      })}
    </div>
  );
});
