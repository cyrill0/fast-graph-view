/** Settings.
 *
 *  The graph options are the core plugin's keys, ranges and defaults verbatim,
 *  so a leaf state or `.obsidian/graph.json` written by the built-in view reads
 *  straight into this plugin and vice versa. Clustering is ours and lives in
 *  `data.json` under `cluster`.
 */

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
  showMetadata: true,
  showStats: true,
};

export interface PluginData {
  graph: GraphOptions;
  cluster: ClusterOptions;
  /** take over the `graph` / `localgraph` view types and the core plugin's surfaces */
  takeover: boolean;
  /** open the clustered graph instead of the native one from the ribbon */
  clusterLocalGraphs: boolean;
}

export const DEFAULT_DATA: PluginData = {
  graph: { ...DEFAULT_GRAPH_OPTIONS },
  cluster: { ...DEFAULT_CLUSTER_OPTIONS },
  takeover: true,
  clusterLocalGraphs: true,
};

/** Shallow-merge persisted data over defaults, keeping nested objects intact. */
export function mergeData(saved: unknown): PluginData {
  if (!saved || typeof saved !== "object") return structuredDefaults();
  const raw = saved as Partial<PluginData>;
  return {
    graph: { ...DEFAULT_GRAPH_OPTIONS, ...(raw.graph ?? {}) },
    cluster: { ...DEFAULT_CLUSTER_OPTIONS, ...(raw.cluster ?? {}) },
    takeover: raw.takeover ?? true,
    clusterLocalGraphs: raw.clusterLocalGraphs ?? true,
  };
}

function structuredDefaults(): PluginData {
  return {
    graph: { ...DEFAULT_GRAPH_OPTIONS },
    cluster: { ...DEFAULT_CLUSTER_OPTIONS },
    takeover: true,
    clusterLocalGraphs: true,
  };
}

/**
 * The keys the core plugin stores in `.obsidian/graph.json`. They are the same
 * shape, so a saved native configuration can seed ours.
 */
export function applyNativeOptions(target: GraphOptions, native: unknown): void {
  if (!native || typeof native !== "object") return;
  const src = native as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_GRAPH_OPTIONS) as (keyof GraphOptions)[]) {
    const value = src[key];
    if (value === undefined) continue;
    if (typeof value === typeof target[key]) {
      // colorGroups needs an element sanity pass - a half-written file is possible
      if (key === "colorGroups" && Array.isArray(value)) {
        target.colorGroups = value
          .filter((g): g is ColorGroup => !!g && typeof (g as ColorGroup).query === "string" && !!(g as ColorGroup).color)
          .map((g) => ({ query: g.query, color: { a: 1, rgb: g.color.rgb ?? 0x888888 } }));
        continue;
      }
      (target as unknown as Record<string, unknown>)[key] = value;
    }
  }
}
