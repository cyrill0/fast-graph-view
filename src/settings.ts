/** Persisted graph and clustering settings for this plugin's standalone views. */

import type { ColorGroup } from "./graph/build";

export interface GraphOptions {
  search: string;
  colorGroups: ColorGroup[];
  "collapse-filter": boolean;
  "collapse-color-groups": boolean;
  "collapse-display": boolean;
  "collapse-forces": boolean;
  showTags: boolean;
  showAttachments: boolean;
  hideUnresolved: boolean;
  showOrphans: boolean;
  showArrow: boolean;
  textFadeMultiplier: number;
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
  scale: number;
  close: boolean;
  localJumps: number;
  localBacklinks: boolean;
  localForelinks: boolean;
  localInterlinks: boolean;
}

/** `0.5187132489703118` is the core plugin's stored default; it maps to 0.1 */
export const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  search: "",
  colorGroups: [],
  "collapse-filter": true,
  "collapse-color-groups": true,
  "collapse-display": true,
  "collapse-forces": true,
  showTags: false,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: true,
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  centerStrength: 0.5187132489703118,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
  scale: 1,
  close: false,
  localJumps: 1,
  localBacklinks: true,
  localForelinks: true,
  localInterlinks: false,
};

export interface ClusterOptions {
  /** the headline rule: folders over `threshold` files become one metadata node */
  enabled: boolean;
  threshold: number;
  /** count files directly in the folder, or its whole subtree */
  mode: "direct" | "recursive";
  /** ceiling on drawn nodes; heavy folders fold until it holds */
  maxVisibleNodes: number;
  /** cap on tag and unresolved nodes */
  maxMetadataNodes: number;
  /** longest name the label overlay draws, in characters; 0 never cuts a label */
  maxLabelChars: number;
  /** hover card / click panel with the folder's rolled-up stats */
  showMetadata: boolean;
  /** the bottom-left line with node, edge and frame timings */
  showStats: boolean;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  enabled: true,
  threshold: 20,
  mode: "direct",
  maxVisibleNodes: 2500,
  maxMetadataNodes: 1200,
  maxLabelChars: 24,
  showMetadata: true,
  showStats: true,
};

export interface PluginData {
  graph: GraphOptions;
  cluster: ClusterOptions;
}

export const DEFAULT_DATA: PluginData = {
  graph: { ...DEFAULT_GRAPH_OPTIONS },
  cluster: { ...DEFAULT_CLUSTER_OPTIONS },
};

const MAX_QUERY_LENGTH = 4096;
const MAX_COLOR_GROUPS = 256;

const NUMERIC_LIMITS: Partial<Record<keyof GraphOptions, [number, number, boolean?]>> = {
  textFadeMultiplier: [-3, 3],
  nodeSizeMultiplier: [0.1, 5],
  lineSizeMultiplier: [0.1, 5],
  centerStrength: [0, 1],
  repelStrength: [0, 20],
  linkStrength: [0, 1],
  linkDistance: [30, 500],
  scale: [1 / 128, 8],
  localJumps: [1, 5, true],
};

const GRAPH_OPTION_KEYS = Object.keys(DEFAULT_GRAPH_OPTIONS) as (keyof GraphOptions)[];

/** Deep-clone a GraphOptions object, including its colorGroups array. */
export function cloneGraphOptions(options: GraphOptions): GraphOptions {
  return {
    ...options,
    colorGroups: options.colorGroups.map((g) => ({
      query: g.query,
      color: { a: g.color.a, rgb: g.color.rgb },
    })),
  };
}

/** Validate and sanitize a colorGroups list from untrusted JSON state. */
export function sanitizeColorGroups(value: unknown): ColorGroup[] {
  if (!Array.isArray(value)) return [];
  const out: ColorGroup[] = [];
  const limit = Math.min(value.length, MAX_COLOR_GROUPS);
  for (let i = 0; i < limit; i++) {
    const item = value[i] as Partial<ColorGroup> | null | undefined;
    if (!item || typeof item !== "object" || typeof item.query !== "string") continue;
    const color = item.color;
    if (!color || typeof color !== "object") continue;
    const rawRgb = color.rgb;
    const rgb =
      typeof rawRgb === "number" && Number.isFinite(rawRgb)
        ? (Math.round(rawRgb) & 0xffffff) >>> 0
        : 0x888888;
    const rawAlpha = color.a;
    const a =
      typeof rawAlpha === "number" && Number.isFinite(rawAlpha)
        ? Math.max(0, Math.min(1, rawAlpha))
        : 1;
    out.push({
      query: item.query.slice(0, MAX_QUERY_LENGTH),
      color: { a, rgb },
    });
  }
  return out;
}

/**
 * Safely merge persisted or native options into `target`, rejecting unknown
 * keys, non-finite numbers, and out-of-range values.
 */
export function applyNativeOptions(target: GraphOptions, native: unknown): void {
  if (!native || typeof native !== "object") return;
  const src = native as Record<string, unknown>;
  const dst = target as unknown as Record<string, unknown>;
  for (const key of GRAPH_OPTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const value = src[key];
    if (value === undefined) continue;
    if (key === "colorGroups") {
      if (Array.isArray(value)) target.colorGroups = sanitizeColorGroups(value);
      continue;
    }
    const defaultVal = DEFAULT_GRAPH_OPTIONS[key];
    if (typeof defaultVal === "boolean") {
      if (typeof value === "boolean") dst[key] = value;
    } else if (typeof defaultVal === "string") {
      if (typeof value === "string") dst[key] = value.slice(0, MAX_QUERY_LENGTH);
    } else if (typeof defaultVal === "number") {
      if (typeof value === "number" && Number.isFinite(value)) {
        const bounds = NUMERIC_LIMITS[key];
        if (bounds) {
          const [min, max, integer] = bounds;
          const clamped = Math.max(min, Math.min(max, value));
          dst[key] = integer ? Math.round(clamped) : clamped;
        } else {
          dst[key] = value;
        }
      }
    }
  }
}

/** Validate and sanitize persisted clustering options. */
export function sanitizeClusterOptions(saved: unknown): ClusterOptions {
  const out: ClusterOptions = { ...DEFAULT_CLUSTER_OPTIONS };
  if (!saved || typeof saved !== "object") return out;
  const src = saved as Record<string, unknown>;
  if (typeof src.enabled === "boolean") out.enabled = src.enabled;
  if (typeof src.showMetadata === "boolean") out.showMetadata = src.showMetadata;
  if (typeof src.showStats === "boolean") out.showStats = src.showStats;
  if (src.mode === "direct" || src.mode === "recursive") out.mode = src.mode;
  if (typeof src.threshold === "number" && Number.isFinite(src.threshold)) {
    out.threshold = Math.max(1, Math.min(10000, Math.round(src.threshold)));
  }
  if (typeof src.maxVisibleNodes === "number" && Number.isFinite(src.maxVisibleNodes)) {
    out.maxVisibleNodes = Math.max(50, Math.min(100000, Math.round(src.maxVisibleNodes)));
  }
  if (typeof src.maxMetadataNodes === "number" && Number.isFinite(src.maxMetadataNodes)) {
    out.maxMetadataNodes = Math.max(0, Math.min(50000, Math.round(src.maxMetadataNodes)));
  }
  if (typeof src.maxLabelChars === "number" && Number.isFinite(src.maxLabelChars)) {
    out.maxLabelChars = Math.max(0, Math.min(80, Math.round(src.maxLabelChars)));
  }
  return out;
}

/** Merge and validate persisted plugin data over defaults. */
export function mergeData(saved: unknown): PluginData {
  const graph = cloneGraphOptions(DEFAULT_GRAPH_OPTIONS);
  if (!saved || typeof saved !== "object") {
    return {
      graph,
      cluster: { ...DEFAULT_CLUSTER_OPTIONS },
    };
  }
  const raw = saved as Partial<PluginData>;
  applyNativeOptions(graph, raw.graph);
  return {
    graph,
    cluster: sanitizeClusterOptions(raw.cluster),
  };
}
