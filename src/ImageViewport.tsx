import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { describeError, readPlacePreviewImage, uncParts, type NamedFile } from "./api";
import { bindingMatches, wheelShortcut } from "./preferences";

const imageTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};

export function imageType(name: string) {
  const extension = /\.([^.]+)$/.exec(name)?.[1].toLowerCase();
  return extension && Object.hasOwn(imageTypes, extension) ? imageTypes[extension] : undefined;
}

export function canEditImage({ name, place }: NamedFile) {
  return place.kind === "local" && !uncParts(place.path)[0] && /\.(?:png|jpe?g)$/i.test(name);
}

export function useImageSource(file: NamedFile, revision = 0) {
  const [content, setContent] = useState<{ url: string } | { error: string }>();
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    setContent(undefined);
    void readPlacePreviewImage(file).then((bytes) => {
      if (!active) return;
      url = URL.createObjectURL(new Blob([bytes], { type: imageType(file.name) }));
      setContent({ url });
    }, (failure: unknown) => { if (active) setContent({ error: describeError(failure) }); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [file, revision]);
  return content;
}

type Size = { width: number; height: number };
type Point = { x: number; y: number };
const inset = 8;

export function useImageViewport(wheel: readonly string[] = []) {
  const [natural, setNatural] = useState<Size>();
  const [viewport, setViewport] = useState<Size>({ width: 1, height: 1 });
  const [turns, setTurns] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ cursor: Point; relative: Point } | null>(null);
  const drag = useRef<{ id: number; start: Point; scroll: Point } | null>(null);
  const width = (turns % 2 ? natural?.height : natural?.width) ?? 0;
  const height = (turns % 2 ? natural?.width : natural?.height) ?? 0;
  const fit = width && height ? Math.min(1, Math.max(1, viewport.width - 2 * inset) / width, Math.max(1, viewport.height - 2 * inset) / height) : 1;
  const scale = zoom ?? fit;

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  function changeZoom(next: number | null, point?: Point) {
    const bounds = frame.current?.getBoundingClientRect();
    const scroller = canvas.current?.getBoundingClientRect();
    if (next !== null && bounds?.width && bounds.height && scroller) {
      const cursor = point ?? { x: scroller.left + scroller.width / 2, y: scroller.top + scroller.height / 2 };
      anchor.current = { cursor, relative: {
        x: (cursor.x - bounds.left) / bounds.width, y: (cursor.y - bounds.top) / bounds.height,
      } };
    } else anchor.current = null;
    const changed = next === null ? null : Math.max(Math.min(1 / 16, fit), Math.min(16, next));
    if (changed === zoom) anchor.current = null;
    setZoom(changed);
  }

  useLayoutEffect(() => {
    const pending = anchor.current;
    const element = canvas.current;
    const bounds = frame.current?.getBoundingClientRect();
    anchor.current = null;
    if (pending && element && bounds) {
      element.scrollLeft += bounds.left + bounds.width * pending.relative.x - pending.cursor.x;
      element.scrollTop += bounds.top + bounds.height * pending.relative.y - pending.cursor.y;
    }
  }, [scale, viewport, width, height, zoom]);

  const zoomWithPointer = useEffectEvent((event: WheelEvent) => {
    if (!natural || failed || !bindingMatches(wheel, wheelShortcut(event)) || !event.deltaY) return;
    event.preventDefault();
    changeZoom(scale * (event.deltaY < 0 ? 1.25 : 0.8), { x: event.clientX, y: event.clientY });
  });
  useEffect(() => {
    const element = canvas.current;
    const listener = (event: WheelEvent) => zoomWithPointer(event);
    element?.addEventListener("wheel", listener, { passive: false });
    return () => element?.removeEventListener("wheel", listener);
  }, []);

  return {
    canvas, frame, drag, natural, setNatural, failed, setFailed, width, height, viewport, scale, turns,
    zoomBy: (factor: number) => changeZoom(scale * factor),
    actualSize: () => changeZoom(1),
    fitToWindow: () => changeZoom(null),
    rotate: (by: number) => setTurns((current) => (current + by + 4) % 4),
    panning: width * scale > viewport.width || height * scale > viewport.height,
  };
}

export function ImageViewport({ name, url, view, hidden = false, children }: {
  name: string; url?: string; view: ReturnType<typeof useImageViewport>; hidden?: boolean; children?: ReactNode;
}) {
  return <div className="quick-view-image-canvas" ref={view.canvas} tabIndex={0} hidden={hidden}
    data-pannable={view.panning || undefined}
    onPointerDown={(event) => {
      if (!view.panning || event.button !== 0 || !event.isPrimary) return;
      const element = event.currentTarget;
      view.drag.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY },
        scroll: { x: element.scrollLeft, y: element.scrollTop } };
      element.setPointerCapture(event.pointerId);
      element.dataset.panning = "true";
    }}
    onPointerMove={(event) => {
      const drag = view.drag.current;
      if (drag?.id !== event.pointerId) return;
      event.currentTarget.scrollLeft = drag.scroll.x + drag.start.x - event.clientX;
      event.currentTarget.scrollTop = drag.scroll.y + drag.start.y - event.clientY;
    }}
    onLostPointerCapture={(event) => { view.drag.current = null; delete event.currentTarget.dataset.panning; }}>
    <div className="image-stage" style={{ minWidth: view.width * view.scale + 2 * inset, minHeight: view.height * view.scale + 2 * inset }}>
      <div className="quick-view-image" ref={view.frame}
        style={{ width: view.width * view.scale, height: view.height * view.scale }}>
        {url && <img alt={name} src={url} draggable={false} style={{
          width: (view.natural?.width ?? 0) * view.scale, height: (view.natural?.height ?? 0) * view.scale,
          transform: `translate(-50%, -50%) rotate(${view.turns * 90}deg)`,
        }} onLoad={({ currentTarget }) => view.setNatural({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight })}
        onError={() => view.setFailed(true)} />}
        {children}
      </div>
    </div>
  </div>;
}
