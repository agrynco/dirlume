import { useLayoutEffect, useRef, useState } from "react";
import type { DiffBlock, DiffLine } from "./compare.worker";

function DiffText({ line }: { line: DiffLine | null }) {
  if (!line?.text) return " ";
  return line.fragments ? line.fragments.map(({ text, changed }, index) =>
    changed ? <mark key={index}>{text}</mark> : text) : line.text;
}

function ChangeConnector({ block, ratio }: { block: DiffBlock; ratio: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const lastRow = block.rows.length - 1;
  const firstMissingLeft = block.rows.findIndex(({ left }) => left === null);
  const firstMissingRight = block.rows.findIndex(({ right }) => right === null);
  const leftEnd = firstMissingLeft < 0 ? lastRow : firstMissingLeft - 1;
  const rightEnd = firstMissingRight < 0 ? lastRow : firstMissingRight - 1;
  const [ends, setEnds] = useState([leftEnd < 0 ? 0 : 100, rightEnd < 0 ? 0 : 100]);

  useLayoutEffect(() => {
    const group = svg.current?.closest(".diff-block");
    const shorter = Math.min(leftEnd, rightEnd);
    if (!group || shorter < 0 || shorter === lastRow) return;
    const row = group.children[shorter];
    const measure = () => {
      const region = group.getBoundingClientRect();
      const bottom = (row.getBoundingClientRect().bottom - region.top) / region.height * 100;
      if (Number.isFinite(bottom)) setEnds(leftEnd < rightEnd ? [bottom, 100] : [100, bottom]);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    observer.observe(row);
    return () => observer.disconnect();
  }, [leftEnd, rightEnd, lastRow, ratio]);

  const [a, b] = ends;
  return <div className="diff-connector" aria-hidden="true">
    <svg ref={svg} viewBox="0 0 24 100" preserveAspectRatio="none">
      <path data-ends={ends.join(",")} className={leftEnd < 0 ? "added" : rightEnd < 0 ? "removed" : "changed"}
        d={`M0 0 H24 V${b} C14 ${b} 10 ${a} 0 ${a} Z`} />
    </svg>
  </div>;
}

export function DiffRows({ block, current, split, connectors, ratio }: {
  block: DiffBlock;
  current: number;
  split: boolean;
  connectors: boolean;
  ratio: number;
}) {
  const changed = block.group !== null;
  const unified = (left: DiffLine | null, right: DiffLine | null, kind: string) =>
    <div key={`${left?.number ?? ""}:${right?.number ?? ""}`} className={`diff-row diff-unified ${kind}`}>
      <span className="diff-number">{left?.number}</span>
      <span className="diff-number">{right?.number}</span>
      <span className="diff-sign" aria-hidden="true">{kind === "added" ? "+" : kind === "removed" ? "−" : ""}</span>
      <span className="diff-text"><DiffText line={right ?? left} /></span>
    </div>;
  const half = (line: DiffLine | null, side: "left" | "right") =>
    <div className={`diff-half ${changed && line ? side === "left" ? "removed" : "added" : ""}`} data-diff-side={side}>
      <span className="diff-number">{line?.number}</span>
      <span className="diff-text"><DiffText line={line} /></span>
    </div>;
  return <div className={`diff-block${changed && block.group === current ? " current" : ""}`}
    data-change={block.group ?? undefined}>
    {split ? block.rows.map(({ left, right }) =>
      <div key={`${left?.number ?? ""}:${right?.number ?? ""}`} className="diff-row diff-split">
        {half(left, "left")}{half(right, "right")}
      </div>
    ) : changed ? <>
      {block.rows.flatMap(({ left }) => left ? unified(left, null, "removed") : [])}
      {block.rows.flatMap(({ right }) => right ? unified(null, right, "added") : [])}
    </> : block.rows.map(({ left, right }) => unified(left, right, "same"))}
    {split && changed && connectors && <ChangeConnector block={block} ratio={ratio} />}
  </div>;
}
