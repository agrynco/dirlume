import { useRef, useState, type CSSProperties } from "react";
import { Repeat2 } from "lucide-react";
import { Button } from "./Button";
import { t } from "./i18n";
import { bounded, cornerOf, cropSize, dragCrop, positionCrop, type Corner, type Crop, type Point, type Size } from "./imageCrop";

const presets = ["Free", "Original", "1:1", "4:3", "3:2", "16:9", "Custom"] as const;
type Ratio = typeof presets[number];
export type CropRatio = { preset: Ratio; custom: Size; swapped: boolean };
const corners: Corner[] = ["nw", "ne", "sw", "se"];
const opposite: Record<Corner, Corner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

export const defaultCropRatio: CropRatio = { preset: "Free", custom: { width: 16, height: 9 }, swapped: false };

export function cropRatio({ preset, custom, swapped }: CropRatio, original: Size) {
  if (preset === "Free") return undefined;
  const [width, height] = preset === "Original" ? [original.width, original.height] :
    preset === "Custom" ? [custom.width, custom.height] : preset.split(":").map(Number);
  return swapped ? height / width : width / height;
}

export function CropToolbar({ crop, image, original, ratio, onCrop, onRatio, onApply, onCancel, applyKey, cancelKey }: {
  crop: Crop; image: Size; original: Size; ratio: CropRatio; onCrop: (crop: Crop) => void;
  onRatio: (ratio: CropRatio) => void; onApply: () => void; onCancel: () => void; applyKey: string; cancelKey: string;
}) {
  function updateRatio(next: CropRatio) {
    const sized = cropSize(crop.width, crop.height, image, cropRatio(next, original));
    onRatio(next);
    onCrop(positionCrop({ ...crop, ...sized }, image));
  }

  function setSize(axis: keyof Size, value: number) {
    const constraint = cropRatio(ratio, original);
    const limits = { width: image.width - crop.x, height: image.height - crop.y };
    const width = axis === "width" ? value : constraint ? value * constraint : crop.width;
    const height = axis === "height" ? value : constraint ? value / constraint : crop.height;
    onCrop({ ...crop, ...cropSize(width, height, limits, constraint) });
  }

  const names = { x: "Crop left", y: "Crop top", width: "Crop width", height: "Crop height" };
  return <div className="text-toolbar image-crop-toolbar">
    <div className="image-controls" role="group" aria-label={t("Crop aspect ratio")}>
      <label>{t("Aspect ratio")}
        <select value={ratio.preset} onChange={(event) => updateRatio({ ...ratio, preset: event.target.value as Ratio, swapped: false })}>
          {presets.map((preset) => <option key={preset} value={preset}>{t(preset)}</option>)}
        </select>
      </label>
      {ratio.preset === "Custom" && (["width", "height"] as const).map((axis) =>
        <label key={axis}>{t(axis === "width" ? "Ratio width" : "Ratio height")}
          <input type="number" min={1} max={10000} value={ratio.custom[axis]} onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => updateRatio({ ...ratio, custom: { ...ratio.custom, [axis]: bounded(Number(event.target.value), 1, 10000) } })} />
        </label>)}
      <Button className="icon-button" aria-label={t("Swap aspect ratio")} aria-pressed={ratio.swapped}
        disabled={ratio.preset === "Free"} onClick={() => updateRatio({ ...ratio, swapped: !ratio.swapped })}><Repeat2 /></Button>
    </div>
    <div className="image-controls" role="group" aria-label={t("Crop coordinates in pixels")}>
      {(["x", "y", "width", "height"] as const).map((axis) =>
        <label key={axis}>{t(axis === "x" ? "X" : axis === "y" ? "Y" : axis === "width" ? "Width" : "Height")}
          <input type="number" aria-label={t(names[axis])} min={axis === "x" || axis === "y" ? 0 : 1}
            value={crop[axis]} onFocus={(event) => event.currentTarget.select()} onChange={(event) => {
              const value = Number(event.target.value);
              if (axis === "x" || axis === "y") onCrop(positionCrop({ ...crop, [axis]: value }, image));
              else setSize(axis, value);
            }} />
        </label>)}
    </div>
    <div className="image-controls">
      <Button onClick={onCancel} shortcut={cancelKey}>{t("Cancel crop")}</Button>
      <Button className="primary" onClick={onApply} shortcut={applyKey}>{t("Apply crop")}</Button>
    </div>
  </div>;
}

type Gesture = { pointer: number; start: Point; crop: Crop; corner?: Corner; moved: boolean };

export function CropOverlay({ crop, image, ratio, scale, onChange }: {
  crop: Crop; image: Size; ratio?: number; scale: number; onChange: (crop: Crop) => void;
}) {
  const gesture = useRef<Gesture>(null);
  const [moving, setMoving] = useState(false);
  const point = (element: HTMLElement, x: number, y: number) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounded((x - bounds.left) / scale, 0, image.width), y: bounded((y - bounds.top) / scale, 0, image.height) };
  };
  const style = {
    "--crop-left": crop.x * scale + "px", "--crop-top": crop.y * scale + "px",
    "--crop-right": (crop.x + crop.width) * scale + "px", "--crop-bottom": (crop.y + crop.height) * scale + "px",
  } as CSSProperties;
  return <div className="image-crop-overlay" data-moving={moving || undefined} style={style}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const target = event.target as HTMLElement;
      const corner = target.dataset.corner as Corner | undefined;
      const start = point(event.currentTarget, event.clientX, event.clientY);
      gesture.current = { start, pointer: event.pointerId, crop, corner, moved: Boolean(target.closest(".image-crop-selection")) && !corner };
      setMoving(gesture.current.moved);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      const drag = gesture.current;
      if (drag?.pointer !== event.pointerId) return;
      const cursor = point(event.currentTarget, event.clientX, event.clientY);
      if (drag.moved) {
        onChange(positionCrop({ ...drag.crop, x: drag.crop.x + cursor.x - drag.start.x,
          y: drag.crop.y + cursor.y - drag.start.y }, image));
      } else if (drag.corner || cursor.x !== drag.start.x || cursor.y !== drag.start.y) {
        const anchor = drag.corner ? cornerOf(drag.crop, opposite[drag.corner]) : drag.start;
        onChange(dragCrop(anchor, cursor, image, ratio));
      }
    }}
    onLostPointerCapture={() => { gesture.current = null; setMoving(false); }}>
    <div className="image-crop-selection" style={{ left: crop.x * scale, top: crop.y * scale,
      width: crop.width * scale, height: crop.height * scale }}>
      {corners.map((corner) => <span key={corner} data-corner={corner} />)}
    </div>
  </div>;
}
