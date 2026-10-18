/** Shared vocabulary for the graph pipeline.
 *
 *  Everything downstream of `raw.ts` works on flat typed arrays so that a
 *  25k-note vault costs a few hundred kilobytes instead of a few hundred
 *  thousand objects.
 */

export const NodeKind = {
  File: 0,
  Attachment: 1,
  Tag: 2,
  Unresolved: 3,
  Cluster: 4,
} as const;
export type NodeKindValue = (typeof NodeKind)[keyof typeof NodeKind];

/** Bit flags - a cluster edge carries `Aggregate` alongside its origin kind. */
export const EdgeKind = {
  Link: 1,
  Tag: 4,
  /** Aggregated bundle of several vault edges, produced by folder clustering. */
  Aggregate: 8,
} as const;

export interface ClusterMeta {
  /** Vault folder path, '' for the vault root. */
  folder: string;
  /** node label, e.g. "003 · 4,620" or "003: 4,412 more" */
  label: string;
  /** Files rolled up into this cluster (recursive). */
  fileCount: number;
  /** Files sitting directly in the folder. */
  directFiles: number;
  /** Child folders represented inside the cluster. */
  childFolders: number;
  /** Links that both start and end inside the cluster and are therefore not drawn. */
  internalLinks: number;
  /** Sum of link weight leaving the cluster. */
  outWeight: number;
  /** Sum of link weight entering the cluster. */
  inWeight: number;
  /** Highest degree members, for the metadata panel / hover card. */
  topFiles: { path: string; name: string; deg: number }[];
  /** Most frequent tags among members. */
  topTags: { tag: string; count: number }[];
  /** Why the folder was collapsed, surfaced in the UI. */
  reason: 'direct' | 'entities' | 'budget' | 'manual';
  /** True for the "… N more" node left behind by a partial expansion. */
  overflow: boolean;
  /** How many members are already drawn elsewhere when this is an overflow node. */
  revealOffset: number;
  /** Every file under the folder, including the ones hidden by filters. */
  subtreeFiles: number;
  /** Recursive byte size of the folder, shown as metadata on the node. */
  sizeBytes: number;
}

/** The renderable graph: node/edge arrays the renderer and simulator consume. */
export interface GraphModel {
  /** monotonic id, bumped on every rebuild */
  revision: number;
  nodeCount: number;
  edgeCount: number;

  kind: Uint8Array;
  /** weighted degree, sum of aggregated link counts */
  degree: Float32Array;
  /** distinct neighbour count - what Obsidian uses for node size and link bias */
  neighbors: Float32Array;
  /** what node sizing reads: `neighbors`, or the local graph's BFS hop weight */
  sizeWeight: Float32Array;
  inDegree: Float32Array;
  outDegree: Float32Array;
  /** index into `RawGraph.filePaths`, -1 when the node is not a vault file */
  fileId: Int32Array;
  /** index into `clusters`, -1 when the node is not a cluster */
  clusterId: Int32Array;
  /** display label (file name, tag, or folder name) */
  label: string[];
  /** vault path for files, folder path for clusters, null for tags/unresolved */
  path: (string | null)[];
  /** resolved color group, -1 = theme default */
  group: Int32Array;
  /** index into RawGraph.folders for this node's home folder, -1 if none */
  folderId: Int32Array;

  /** interleaved x,y - owned by the simulator between builds */
  pos: Float32Array;
  /** 1 when the node is pinned (fx/fy honoured) */
  pinned: Uint8Array;
  fx: Float32Array;
  fy: Float32Array;

  eu: Int32Array;
  ev: Int32Array;
  ew: Float32Array;
  ek: Uint8Array;

  /** CSR adjacency, includes both directions */
  adjOff: Int32Array;
  adjNode: Int32Array;
  adjEdge: Int32Array;

  clusters: ClusterMeta[];
  /** nodes hidden by the node budget, folded into overflow clusters */
  overflow: { kind: number; count: number }[];
  /** stats for the status line */
  stats: {
    files: number;
    shownFiles: number;
    rawEdges: number;
    shownEdges: number;
    clusters: number;
    collapsedFiles: number;
  };
}

export interface SimState {
  revision: number;
  nodeCount: number;
  edgeCount: number;
  /** interleaved x,y snapshot, transferred between threads */
  pos: Float32Array;
  alpha: number;
  settled: boolean;
}

export interface Viewport {
  x: number;
  y: number;
  /** world units per CSS pixel inverse: scale 2 = zoomed in */
  scale: number;
  width: number;
  height: number;
}
