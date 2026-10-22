/** Label overlay.
 *
 *  Labels are the one part of the picture that reads better in a 2D canvas than
 *  in an atlas: they are the only text, they need the theme font, and only the
 *  ones on screen matter. The fade rules are still the native ones -
 *  `textAlpha = clamp(log2(zoom) + 1 - textFadeMultiplier, 0, 1)`,
 *  `fontSize = 14 + size / 4`, screen size `* sqrt(zoom)` - with a hard cap on
 *  how many strings are drawn per frame so a zoomed-out mega-graph stays
 *  interactive.
 *
 *  Drawn names go through `shortenLabel`: a vault whose median title is 37
 *  characters, and whose unresolved links carry a whole path as their label,
 *  otherwise paints overlapping 900 px strings over each other. Only the canvas
 *  sees the cut - the model keeps the full label for filters, node identity,
 *  hover previews and the file menu, and the hovered label is always drawn whole.
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
  /** longest drawn name in characters; 0 draws the model's label whole */
  maxChars: number;
}

export class LabelLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private blank = true;
  /** shortened labels for the current cap - the same node is redrawn every frame */
  private shortCache = new Map<string, string>();
  private shortCacheMax = -1;

  constructor(host: Element) {
    const canvas = document.createElement("canvas");
    canvas.className = "graph-canvas fast-graph-labels";
    this.ctx = canvas.getContext("2d");
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
    this.blank = true;
  }

  clear(): void {
    const ctx = this.ctx;
    if (this.blank || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.blank = true;
  }

  private shorten(text: string, maxChars: number): string {
    if (maxChars <= 0) return text;
    if (this.shortCacheMax !== maxChars || this.shortCache.size > 4096) {
      this.shortCache.clear();
      this.shortCacheMax = maxChars;
    } else {
      const cached = this.shortCache.get(text);
      if (cached !== undefined) return cached;
    }
    const short = shortenLabel(text, maxChars);
    this.shortCache.set(text, short);
    return short;
  }

  render(pass: LabelPass, camera: Camera): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (pass.textAlpha <= 0.001 || camera.zoom <= 0) {
      this.clear();
      return;
    }
    if (!this.blank) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      this.blank = true;
    } else {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    const zoom = camera.zoom;
    const panX = camera.panX;
    const panY = camera.panY;
    const zoomScale = Math.sqrt(zoom);
    const left = -20;
    const right = this.width + 20;
    const top = -20;
    const bottom = this.height + 20;
    let drawn = 0;
    let wrapped = 0;
    let lastFontSize = -1;
    let lastAlpha = -1;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = pass.color;

    const pos = pass.pos;
    const radii = pass.radii;
    const fade = pass.fade;
    const labels = pass.labels;
    const maxLabels = pass.maxLabels;
    const hoveredIdx = pass.hovered;

    for (let i = 0; i < pass.nodeCount; i++) {
      // The hovered label is drawn once, last, below. This lets the normal pass
      // stop as soon as its budget is full instead of scanning every remaining
      // node merely in case the hovered index is near the end of a huge model.
      if (i === hoveredIdx) continue;
      if (drawn >= maxLabels) break;
      const alpha = fade[i] * pass.textAlpha;
      if (alpha <= 0.001) continue;
      const x = pos[i * 2] * zoom + panX;
      const y = pos[i * 2 + 1] * zoom + panY;
      if (x < left || x > right || y < top || y > bottom) continue;
      const r = radii[i];
      const size = r * zoomScale;
      const fontSize = Math.round((14 + r / 4) * zoomScale * 2) * 0.5;
      if (fontSize < 7) continue;
      const labelY = y + size + 5 * zoomScale;
      drawn++;
      const clampedAlpha = Math.min(1, alpha);
      if (Math.abs(clampedAlpha - lastAlpha) > 0.005) {
        ctx.globalAlpha = clampedAlpha;
        lastAlpha = clampedAlpha;
      }
      if (fontSize !== lastFontSize) {
        ctx.font = `${fontSize}px ${pass.fontStack}`;
        lastFontSize = fontSize;
      }
      const text = this.shorten(labels[i], pass.maxChars);
      const wrapAt = 300 * zoomScale;
      if (text.length > 18 && ctx.measureText(text).width > wrapAt && wrapped < 60) {
        wrapped++;
        wrapLine(ctx, text, x, labelY, wrapAt, fontSize);
      } else {
        ctx.fillText(text, x, labelY);
      }
    }

    if (hoveredIdx >= 0 && hoveredIdx < pass.nodeCount) {
      const i = hoveredIdx;
      const x = pos[i * 2] * zoom + panX;
      const y = pos[i * 2 + 1] * zoom + panY;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        const r = radii[i];
        const size = r * zoomScale;
        // Native keeps the hovered label legible below zoom 1 by using 1/zoom.
        const fontScale = zoom < 1 ? 1 / zoom : zoomScale;
        const fontSize = Math.round((14 + r / 4) * fontScale * 2) * 0.5;
        const labelY = y + size + 20 * zoomScale;
        if (lastAlpha !== pass.textAlpha) ctx.globalAlpha = Math.min(1, pass.textAlpha);
        if (fontSize !== lastFontSize) ctx.font = `${fontSize}px ${pass.fontStack}`;
        const text = labels[i];
        const wrapAt = 300 * zoomScale;
        if (text.length > 18 && ctx.measureText(text).width > wrapAt && wrapped < 60) {
          wrapLine(ctx, text, x, labelY, wrapAt, fontSize);
        } else {
          ctx.fillText(text, x, labelY);
        }
        drawn++;
      }
    }
    if (drawn > 0) this.blank = false;
    ctx.globalAlpha = 1;
  }
}

/** trailing characters a name may give up so the cut lands after a whole word */
const WORD_SLACK = 8;

/**
 * Cut a label to `maxChars` for the canvas; `0` and `1` draw it whole.
 *
 * A leading path goes first: an unresolved link is labelled with its raw
 * linktext, so `Courses/X/Resources/Slides/bar.pdf` would otherwise paint a
 * whole file system across the graph. A tag keeps its path - `#area/project` is
 * the information there. The remainder is cut on a word where one sits close to
 * the budget, and never between the halves of a surrogate pair.
 */
export function shortenLabel(text: string, maxChars: number): string {
  if (maxChars <= 1) return text;
  let body = text;
  const slash = body.lastIndexOf("/");
  // 35 is "#": cutting a nested tag would merge it with its siblings
  if (slash >= 0 && body.charCodeAt(0) !== 35) body = body.slice(slash + 1);
  if (body.length <= maxChars) return body;
  let cut = maxChars - 1;
  const space = body.lastIndexOf(" ", cut - 1);
  if (space >= cut - Math.min(WORD_SLACK, cut >> 2)) cut = space;
  while (cut > 1 && body.charCodeAt(cut - 1) === 32) cut--;
  const lead = body.charCodeAt(cut - 1);
  if (lead >= 0xd800 && lead <= 0xdbff) cut--;
  return `${body.slice(0, cut)}…`;
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
