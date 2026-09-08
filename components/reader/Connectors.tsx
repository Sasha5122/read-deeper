"use client";

import type { CardPosition } from "./useMarginLayout";

const DOT_COLORS: Record<string, string> = {
  amber: "#e0b446",
  green: "#5f9e5f",
  blue: "#5f83ac",
  rose: "#c06a76",
};

interface ConnectorsProps {
  positions: Map<string, CardPosition>;
  /** Highlight colour name per highlight id — the junction dot wears it. */
  colorById: Record<string, string>;
  activeId: string | null;
  /** x where the text column ends, relative to the reader container. */
  textRight: number;
  height: number;
}

interface Geometry {
  id: string;
  d: string;
  x2: number;
  y2: number;
  active: boolean;
  dotColor: string;
}

/**
 * Lines from each highlight to its card, routed through white space only:
 * a short run in the inter-line gap below the highlighted line, then through
 * the gutter between the text column and the cards. Each line ends in a
 * junction dot pinned on the card's edge (drawn above the card so it reads
 * as a node, not a cut-off line).
 */
export function Connectors({ positions, colorById, activeId, textRight, height }: ConnectorsProps) {
  const geo: Geometry[] = [];
  for (const [id, pos] of positions) {
    const x1 = Math.min(pos.anchorRight + 3, textRight);
    const y1 = pos.anchorBottom + 2; // inter-line white space
    const gx = textRight + 6; // gutter, right of the text column
    const x2 = pos.cardX;
    const y2 = pos.top + 18; // vertical middle of a collapsed pill / dot row of an open card
    if (x2 <= gx) continue;
    const mid = gx + (x2 - gx) / 2;
    geo.push({
      id,
      d: `M ${x1} ${y1} L ${gx} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
      x2,
      y2,
      active: id === activeId,
      dotColor: DOT_COLORS[colorById[id]] ?? "#9a9a9a",
    });
  }

  const svgProps = {
    width: "100%",
    height,
    "aria-hidden": true,
  } as const;

  return (
    <>
      {/* Lines: under the cards, over the sheets */}
      <svg className="pointer-events-none absolute inset-0 z-10" {...svgProps}>
        {geo.map((g) => (
          <path
            key={g.id}
            d={g.d}
            fill="none"
            stroke={g.active ? "#3d3d3d" : "#bdbdbd"}
            strokeWidth={g.active ? 1.75 : 1.25}
            strokeLinecap="round"
          />
        ))}
      </svg>
      {/* Junction dots: above the cards, pinned on their edge */}
      <svg className="pointer-events-none absolute inset-0 z-30" {...svgProps}>
        {geo.map((g) => (
          <circle key={g.id} cx={g.x2} cy={g.y2} r={g.active ? 2 : 1.6} fill={g.dotColor} />
        ))}
      </svg>
    </>
  );
}
