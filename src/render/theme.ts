/** Colour resolution.
 *
 *  The native graph keeps no colour settings at all - it probes computed CSS
 *  on hidden `.graph-view.color-*` elements and re-reads them on
 *  `css-change`. Doing the same means themes that override `--graph-node` and
 *  friends style this view for free.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface GraphColors {
  fill: Rgba;
  fillFocused: Rgba;
  fillTag: Rgba;
  fillUnresolved: Rgba;
  fillAttachment: Rgba;
  fillHighlight: Rgba;
  arrow: Rgba;
  circle: Rgba;
  line: Rgba;
  lineHighlight: Rgba;
  text: Rgba;
}

const CLASS_BY_KEY: Record<keyof GraphColors, string> = {
  fill: "color-fill",
  fillFocused: "color-fill-focused",
  fillTag: "color-fill-tag",
  fillUnresolved: "color-fill-unresolved",
  fillAttachment: "color-fill-attachment",
  fillHighlight: "color-fill-highlight",
  arrow: "color-arrow",
  circle: "color-circle",
  line: "color-line",
  lineHighlight: "color-line-highlight",
  text: "color-text",
};

const KEYS = Object.keys(CLASS_BY_KEY) as (keyof GraphColors)[];

/** fallback used when a class resolves to nothing, = #888888 as in app.js */
const FALLBACK: Rgba = { r: 0.533, g: 0.533, b: 0.533, a: 1 };

export class ThemeReader {
  private probe: HTMLDivElement;
  private children = new Map<string, HTMLElement>();
  colors: GraphColors = emptyColors();
  textCss = "rgba(136, 136, 136, 1)";

  constructor(host: Element) {
    const probe = document.createElement("div");
    probe.className = "graph-view fast-graph-probe";
    probe.setAttribute("aria-hidden", "true");
    host.appendChild(probe);
    this.probe = probe;
    this.refresh();
  }

  refresh(): void {
    const style = getComputedStyle(this.probe);
    const out = emptyColors();
    for (const key of KEYS) {
      const el = this.getProbeChild(CLASS_BY_KEY[key], style);
      out[key] = parseColor(el.color, el.opacity) ?? FALLBACK;
    }
    this.colors = out;
    const t = out.text;
    this.textCss = `rgba(${Math.round(t.r * 255)}, ${Math.round(t.g * 255)}, ${Math.round(t.b * 255)}, ${t.a})`;
  }

  destroy(): void {
    this.children.clear();
    this.probe.remove();
  }

  private getProbeChild(cls: string, parentStyle: CSSStyleDeclaration): { color: string; opacity: string } {
    let el = this.children.get(cls);
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      el.className = `graph-view ${cls}`;
      el.setAttribute("aria-hidden", "true");
      this.probe.appendChild(el);
      this.children.set(cls, el);
    }
    const style = getComputedStyle(el);
    const color = style.color;
    const rawOpacity = style.opacity;
    // the color-* classes carry their own opacity; inherit the parent's when unset
    const opacity = rawOpacity === "" || rawOpacity === "1" ? parentStyle.opacity : rawOpacity;
    return { color, opacity };
  }
}

function parseColor(color: string, opacity: string): Rgba | null {
  if (!color) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 1;
  const rgb = color.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const parts = rgb[1].split(/[\s,\/]+/).filter((s) => s.length > 0).map(Number);
    if (parts.length < 3 || parts.some((v) => Number.isNaN(v))) return null;
    [r, g, b] = parts;
    if (parts.length > 3) a = parts[3];
  } else if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16) / 255;
    } else if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      if (hex.length >= 8) a = parseInt(hex.slice(6, 8), 16) / 255;
    } else {
      return null;
    }
  } else {
    return null;
  }
  const extra = Number.parseFloat(opacity);
  if (!Number.isNaN(extra)) a *= extra;
  return { r: r / 255, g: g / 255, b: b / 255, a };
}

function emptyColors(): GraphColors {
  const clone = (): Rgba => ({ ...FALLBACK });
  return {
    fill: clone(),
    fillFocused: clone(),
    fillTag: clone(),
    fillUnresolved: clone(),
    fillAttachment: clone(),
    fillHighlight: clone(),
    arrow: clone(),
    circle: clone(),
    line: clone(),
    lineHighlight: clone(),
    text: clone(),
  };
}

/** Pack an Rgba into the premultiplied float stream used by the renderer. */
export function writeColor(target: Float32Array, offset: number, color: Rgba, alphaScale: number): void {
  target[offset] = color.r;
  target[offset + 1] = color.g;
  target[offset + 2] = color.b;
  target[offset + 3] = color.a * alphaScale;
}
