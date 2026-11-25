import { useCallback, useEffect, useRef, useState, type RefObject, type MouseEvent, type PointerEvent } from "react";

type Row = { name: string };

type Point = { x: number; y: number };
type Gesture<Item> = {
  id: number;
  start: Item | null;
  position: Point;
  started: number;
  timer: number;
  mode: "hold" | "drag" | "cancelled";
  mark: boolean;
  visited: Set<string>;
};

const holdDelay = 500;
const interval = 8;
const point = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY });

function hit<Item extends Row>(list: HTMLDivElement | null, entries: readonly Item[], { x, y }: Point) {
  const element = document.elementFromPoint(x, y);
  if (!list?.contains(element) || element?.closest(".inline-rename")) return undefined;
  const index = element?.closest<HTMLElement>(".file-row")?.dataset.entryIndex;
  return index === undefined ? null : entries[Number(index)] ?? null;
}

export function useRightClickSelection<Item extends Row>({ list, entries, marked, enabled, scope, onMark, onContext }: {
  list: RefObject<HTMLDivElement | null>;
  entries: readonly Item[];
  marked: ReadonlySet<string>;
  enabled: boolean;
  scope: string;
  onMark: (names: readonly string[], mark: boolean) => void;
  onContext: (x: number, y: number, entry?: Item) => void;
}) {
  const gesture = useRef<Gesture<Item> | null>(null);
  const [spinner, setSpinner] = useState<Point | null>(null);
  const [gestureEntries, setGestureEntries] = useState<readonly Item[] | null>(null);
  const visibleEntries = gestureEntries ?? entries;

  const clear = useCallback(() => {
    const current = gesture.current;
    gesture.current = null;
    if (current) {
      window.clearTimeout(current.timer);
      if (list.current?.hasPointerCapture(current.id)) list.current.releasePointerCapture(current.id);
    }
    setSpinner(null);
    setGestureEntries(null);
  }, [list]);

  useEffect(() => {
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [clear, enabled, scope]);

  function move(current: Gesture<Item>, next: Point) {
    if (current.mode === "cancelled") return;
    const previous = current.position;
    current.position = next;
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const steps = Math.max(1, Math.min(512, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / interval)));
    const startName = current.start?.name;
    const crossed = new Set(current.mode === "hold" && startName && startName !== ".." ? [startName] : []);
    let departed = false;
    for (let index = 1; index <= steps; index++) {
      const fraction = index / steps;
      const row = hit(list.current, visibleEntries, { x: previous.x + dx * fraction, y: previous.y + dy * fraction });
      if (row === undefined || row?.name !== current.start?.name) departed = true;
      if (row && row.name !== "..") crossed.add(row.name);
    }
    if (current.mode === "hold") {
      if (!departed) {
        if (performance.now() - current.started >= holdDelay) setSpinner(next);
        return;
      }
      window.clearTimeout(current.timer);
      setSpinner(null);
      if (!current.start || current.start.name === "..") {
        current.mode = "cancelled";
        return;
      }
      current.mode = "drag";
    }
    const changed = [...crossed].filter((name) => !current.visited.has(name));
    if (changed.length) {
      for (const name of changed) current.visited.add(name);
      onMark(changed, current.mark);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || event.button !== 2 || event.pointerType !== "mouse") return;
    const listElement = list.current;
    if (!listElement) return;
    const position = point(event);
    const start = hit(listElement, visibleEntries, position);
    if (start === undefined) return;
    event.preventDefault();
    clear();
    // Marked-first sorting would otherwise move rows while the pointer crosses them.
    setGestureEntries(visibleEntries);
    listElement.focus({ preventScroll: true });
    listElement.setPointerCapture(event.pointerId);
    const current: Gesture<Item> = {
      id: event.pointerId, start, position, started: performance.now(), timer: 0, mode: "hold",
      mark: start ? !marked.has(start.name) : true, visited: new Set(),
    };
    current.timer = window.setTimeout(() => {
      if (gesture.current === current && current.mode === "hold") setSpinner(current.position);
    }, holdDelay);
    gesture.current = current;
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    if (!(event.buttons & 2)) { clear(); return; }
    move(current, point(event));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId || event.button !== 2) return;
    const position = point(event);
    move(current, position);
    clear();
    if (current.mode !== "hold") return;
    const row = hit(list.current, visibleEntries, position);
    if (row === undefined) return;
    if (performance.now() - current.started >= holdDelay) {
      onContext(position.x, position.y, row && row.name !== ".." ? row : undefined);
    } else if (row && row.name !== "..") {
      onMark([row.name], current.mark);
    }
  }

  function suppressContextMenu(event: MouseEvent) {
    return enabled && (gesture.current !== null || event.button === 2) &&
      !(event.target instanceof Element && event.target.closest(".inline-rename"));
  }

  return { spinner, entries: visibleEntries, selecting: gestureEntries !== null, suppressContextMenu,
    events: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: clear, onLostPointerCapture: clear } };
}
