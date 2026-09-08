"use client";

interface CaptureVerifyProps {
  image: string | null;
  onClose: () => void;
}

/**
 * Verification window for the capture tool: shows exactly the pixels that
 * were grabbed, so the reader can confirm the screenshot caught what they
 * framed. (Kept simple on purpose — a test/inspection aid.)
 */
export function CaptureVerify({ image, onClose }: CaptureVerifyProps) {
  if (!image) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[12vh]"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Captured area"
        className="w-[min(38rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_18px_50px_rgba(0,0,0,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2.5">
          <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Captured area — this is what the chat will be about
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
          >
            ✕
          </button>
        </div>
        <div className="grid place-items-center bg-neutral-50 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image}
            alt="Captured region"
            data-testid="capture-preview"
            className="max-h-[55vh] max-w-full border border-neutral-200 bg-white shadow-sm"
          />
        </div>
        <p className="border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-400">
          Saved with the document — reopen the session and the rectangle, its colour and its chat
          will still be there.
        </p>
      </div>
    </div>
  );
}
