import { t } from "./i18n";
import { useState, type CSSProperties, type PointerEvent } from "react";
import { isHexColor } from "./appearance";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

type Color = { hue: number; saturation: number; brightness: number };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function parseColor(hex: string): Color {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels;
  const brightness = Math.max(...channels);
  const span = brightness - Math.min(...channels);
  const saturation = brightness ? span / brightness : 0;
  if (!span) return { hue: 0, saturation, brightness };
  const sector = brightness === red ? (green - blue) / span :
    brightness === green ? (blue - red) / span + 2 : (red - green) / span + 4;
  return { hue: (sector * 60 + 360) % 360, saturation, brightness };
}

function toHex({ hue, saturation, brightness }: Color) {
  const chroma = brightness * saturation;
  const sector = hue / 60;
  const edge = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] = [
    [chroma, edge, 0], [edge, chroma, 0], [0, chroma, edge],
    [0, edge, chroma], [edge, 0, chroma], [chroma, 0, edge],
  ][Math.floor(sector) % 6];
  const offset = brightness - chroma;
  return "#" + [red, green, blue].map((channel) =>
    Math.round((channel + offset) * 255).toString(16).padStart(2, "0")).join("");
}

export function ColorPicker({ label, initial, onChange, onCommit, onCancel }: {
  label: string;
  initial: string;
  onChange: (hex: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const [color, setColor] = useState(() => parseColor(initial));
  const [hex, setHex] = useState(initial);
  const current = toHex(color);
  const valid = isHexColor(hex);

  function change(next: Color) {
    setColor(next);
    const value = toHex(next);
    setHex(value);
    onChange(value);
  }

  function choosePosition(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    change({
      ...color,
      saturation: clamp((event.clientX - bounds.left) / bounds.width),
      brightness: 1 - clamp((event.clientY - bounds.top) / bounds.height),
    });
  }

  return (
    <Dialog title={t("{0} color", t(label))} onClose={onCancel}>
      <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (valid) onCommit(); }}>
        <div className="dialog-body color-picker">
          <div className="color-plane" role="group" aria-label={t("Saturation and brightness. Use arrow keys to adjust.")}
            tabIndex={0} style={{ backgroundColor: "hsl(" + color.hue + " 100% 50%)" }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              choosePosition(event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) choosePosition(event);
            }}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              const step = event.shiftKey ? 0.1 : 0.01;
              const saturation = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
              const brightness = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
              change({ ...color, saturation: clamp(color.saturation + saturation), brightness: clamp(color.brightness + brightness) });
            }}>
            <span className="color-plane-marker" aria-hidden="true"
              style={{ left: color.saturation * 100 + "%", top: (1 - color.brightness) * 100 + "%" }} />
          </div>
          <label className="color-hue">
            <span>{t("Hue")}</span>
            <input type="range" min={0} max={359} value={Math.floor(color.hue)}
              onChange={(event) => change({ ...color, hue: event.target.valueAsNumber })} />
          </label>
          <div className="color-picker-values">
            <label className="field">HEX
              <input data-initial-focus type="text" value={hex} maxLength={7} spellCheck={false} autoComplete="off"
                aria-invalid={!valid} onChange={(event) => {
                  const value = event.target.value;
                  const normalized = "#" + value.replace(/^#/, "").toLowerCase();
                  setHex(isHexColor(normalized) ? normalized : value);
                  if (!isHexColor(normalized)) return;
                  setColor(parseColor(normalized));
                  onChange(normalized);
                }} />
            </label>
            <div className="color-picker-swatches">
              <span title={t("Original color {0}", initial)} style={{ "--swatch": initial } as CSSProperties} />
              <span title={t("Selected color {0}", current)} style={{ "--swatch": current } as CSSProperties} />
            </div>
          </div>
        </div>
        <footer className="dialog-footer">
          <Button type="button" onClick={onCancel}>{t("Cancel")}</Button>
          <Button type="submit" className="primary" disabled={!valid}>{t("Use color")}</Button>
        </footer>
      </form>
    </Dialog>
  );
}
