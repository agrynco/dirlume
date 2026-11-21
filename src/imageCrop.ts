export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Crop = Point & Size;
export type ImageTransform = Crop & { turns: number };
export type Corner = "nw" | "ne" | "sw" | "se";

export function imageSize({ width, height, turns }: ImageTransform): Size {
  return turns % 2 ? { width: height, height: width } : { width, height };
}

export function applyImageCrop(edit: ImageTransform, crop: Crop): ImageTransform {
  const { x, y, width, height, turns } = edit;
  switch (turns) {
    case 1: return { x: x + crop.y, y: y + height - crop.x - crop.width, width: crop.height, height: crop.width, turns };
    case 2: return { x: x + width - crop.x - crop.width, y: y + height - crop.y - crop.height, width: crop.width, height: crop.height, turns };
    case 3: return { x: x + width - crop.y - crop.height, y: y + crop.x, width: crop.height, height: crop.width, turns };
    default: return { x: x + crop.x, y: y + crop.y, width: crop.width, height: crop.height, turns };
  }
}

export function imageMatrix({ x, y, width, height, turns }: ImageTransform, scale: number) {
  const [a, b, c, d, dx, dy] = [
    [1, 0, 0, 1, -x, -y],
    [0, 1, -1, 0, y + height, -x],
    [-1, 0, 0, -1, x + width, y + height],
    [0, -1, 1, 0, -y, x + width],
  ][turns];
  return `matrix(${[a, b, c, d, dx, dy].map((value) => value * scale).join(", ")})`;
}

export function bounded(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, Math.round(value)));
}

export function cropSize(width: number, height: number, limits: Size, ratio: number | undefined): Size {
  if (!ratio) return { width: bounded(width, 1, limits.width), height: bounded(height, 1, limits.height) };
  const fittedWidth = Math.min(limits.width, limits.height * ratio, Math.max(width, height * ratio));
  return { width: bounded(fittedWidth, 1, limits.width), height: bounded(fittedWidth / ratio, 1, limits.height) };
}

export function positionCrop(crop: Crop, image: Size): Crop {
  return { ...crop, x: bounded(crop.x, 0, image.width - crop.width), y: bounded(crop.y, 0, image.height - crop.height) };
}

export function cornerOf(crop: Crop, corner: Corner): Point {
  return { x: crop.x + (corner.endsWith("e") ? crop.width : 0), y: crop.y + (corner.startsWith("s") ? crop.height : 0) };
}

export function dragCrop(anchor: Point, pointer: Point, image: Size, ratio: number | undefined): Crop {
  const left = pointer.x < anchor.x || anchor.x === image.width;
  const up = pointer.y < anchor.y || anchor.y === image.height;
  const limits = { width: left ? anchor.x : image.width - anchor.x, height: up ? anchor.y : image.height - anchor.y };
  const size = cropSize(Math.abs(pointer.x - anchor.x), Math.abs(pointer.y - anchor.y), limits, ratio);
  return { ...size, x: anchor.x - (left ? size.width : 0), y: anchor.y - (up ? size.height : 0) };
}
