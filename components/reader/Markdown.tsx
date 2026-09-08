"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Tiny, safe Markdown renderer for AI answers in the margin cards: headings,
 * lists, bold/italic/inline code, links. React elements only — no raw HTML.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // links first, then bold, italic, code
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[1] !== undefined) {
      const href = m[2].replace(/[?&]utm_source=[^&)]+/g, "");
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className="text-neutral-700 underline decoration-neutral-400 underline-offset-2 hover:text-black">
          {m[1]}
        </a>,
      );
    } else if (m[3] !== undefined) {
      out.push(<strong key={key} className="font-semibold">{inline(m[3], key)}</strong>);
    } else if (m[4] !== undefined) {
      out.push(<em key={key}>{inline(m[4], key)}</em>);
    } else if (m[5] !== undefined) {
      out.push(<code key={key} className="rounded bg-neutral-100 px-1 py-0.5 text-[12px]">{m[5]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={key++} className="my-1 first:mt-0 last:mb-0">
        {para.map((l, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {inline(l, `p${key}-${i}`)}
          </Fragment>
        ))}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => (
      <li key={i} className="my-0.5">{inline(it, `li${key}-${i}`)}</li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={key++} className="my-1 list-decimal space-y-0 pl-4">{items}</ol>
      ) : (
        <ul key={key++} className="my-1 list-disc space-y-0 pl-4">{items}</ul>
      ),
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      blocks.push(
        <p key={key++} className="mb-0.5 mt-2 font-semibold first:mt-0">
          {inline(h[2], `h${key}`)}
        </p>,
      );
    } else if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const item = (ol ?? ul)![1];
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(item);
    } else if (line.trim() === "") {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return <div className="min-w-0">{blocks}</div>;
}
