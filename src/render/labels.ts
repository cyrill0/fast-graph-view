/** Label overlay.
 *
 *  Labels are the one part of the picture that reads better in a 2D canvas than
 *  in an atlas: they are the only text, they need the theme font, and only the
 *  ones on screen matter. The fade rules are still the native ones -
 *  `textAlpha = clamp(log2(zoom) + 1 - textFadeMultiplier, 0, 1)`,
 *  `fontSize = 14 + size / 4`, screen size `* sqrt(zoom)` - with a hard cap on
 *  how many strings are drawn per frame so a zoomed-out mega-graph stays
 *  interactive.
 */

import type { Camera } from "./camera";

export interface LabelPass {
  labels: string[];
  pos: Float32Array;
  radii: Float32Array;
  /** eased 0.2 … 1 per node */
  fade: Float32Array;
  nodeCount: number;
  /** base visibility from the text fade threshold */
  textAlpha: number;
  color: string;
  fontStack: string;
  hovered: number;
  maxLabels: number;
}

export class LabelLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;

  constructor(host: Element) {
    const canvas = document.createElement("canvas");
    canvas.className = "graph-canvas fast-graph-labels";
    this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    host.appendChild(canvas);
    this.canvas = canvas;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.width = Math.max(1, Math.floor(cssWidth));
    this.height = Math.max(1, Math.floor(cssHeight));
    this.dpr = dpr;
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  render(pass: LabelPass, camera: Camera): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (pass.textAlpha <= 0.001 || camera.zoom <= 0) return;

    const zoomScale = Math.sqrt(camera.zoom);
    const left = -20;
    const right = this.width + 20;
    const top = -20;
    const bottom = this.height + 20;
    let drawn = 0;
    let wrapped = 0;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let i = 0; i < pass.nodeCount && drawn < pass.maxLabels; i++) {
      const hovered = i === pass.hovered;
      const alpha = (hovered ? 1 : pass.fade[i]) * pass.textAlpha;
      if (alpha <= 0.001) continue;
      const size = pass.radii[i] * zoomScale;
      const x = camera.worldToScreenX(pass.pos[i * 2]);
      const y = camera.worldToScreenY(pass.pos[i * 2 + 1]);
      if (x < left || x > right || y < top || y > bottom) continue;
      // native keeps the hovered label legible below zoom 1 by using 1/zoom
      const fontScale = hovered && camera.zoom < 1 ? 1 / camera.zoom : zoomScale;
      const fontSize = (14 + pass.radii[i] / 4) * fontScale;
      if (fontSize < 7 && !hovered) continue;
      const labelY = y + size + 5 * zoomScale + (hovered ? 15 * zoomScale : 0);
      drawn++;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = pass.color;
      ctx.font = `${fontSize}px ${pass.fontStack}`;
      const text = pass.labels[i];
      const wrapAt = 300 * zoomScale;
      if (text.length > 18 && ctx.measureText(text).width > wrapAt && wrapped < 60) {
        wrapped++;
        wrapLine(ctx, text, x, labelY, wrapAt, fontSize);
      } else {
        ctx.fillText(text, x, labelY);
      }
    }
    ctx.globalAlpha = 1;
  }
}

function wrapLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  fontSize: number,
): void {
  const words = text.split(" ");
  let line = "";
  let row = 0;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      ctx.fillText(line, x, y + row * fontSize * 1.15);
      line = word;
      row++;
      if (row > 2) return;
    } else {
      line = next;
    }
  }
  if (line) ctx.fillText(line, x, y + row * fontSize * 1.15);
}

/** native `textAlpha` law */
export function textAlphaFor(zoom: number, textFadeMultiplier: number): number {
  const raw = Math.log2(zoom) + 1 - textFadeMultiplier;
  return Math.max(0, Math.min(1, raw));
}
