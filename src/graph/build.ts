import { EdgeKind, NodeKind, type ClusterMeta, type GraphModel } from './types';
import type { RawGraph } from './raw';
import { BackIndex, GraphQuery } from './query';

export interface ColorGroup {
  query: string;
  /** native graph.json shape: 0xRRGGBB plus an always-1 alpha slot */
  color: { a: number; rgb: number };
}

export interface BuildOptions {
  showAttachments: boolean;
  showTags: boolean;
  showUnresolved: boolean;
  showOrphans: boolean;
  minTagUses: number;
  /** cap on how many tag / unresolved nodes survive */
  maxNonFileNodes: number;

  clusterEnabled: boolean;
  /** a folder with strictly more than this many files collapses to one node */
  clusterThreshold: number;
  /** 'direct' counts files in the folder, 'recursive' counts its subtree */
  clusterMode: 'direct' | 'recursive';
  /** ceiling on drawn nodes; the heaviest folders fold until it holds */
  maxVisibleNodes: number;
  /** folder path -> members revealed; presence means the user expanded it */
  revealOverrides: Map<string, number>;
  /** folders collapsed by hand even though they are small */
  forcedCollapsed: Set<string>;

  /** scope path for a local graph, null for the whole vault */
  scopePath: string | null;
  scopeDepth: number;
  /** local graph: follow outgoing links */
  scopeForelinks: boolean;
  /** local graph: follow incoming links */
  scopeBacklinks: boolean;
  /** local graph: also draw links between neighbours */
  scopeInterlinks: boolean;

  /**
   * Timelapse: only the N oldest notes are candidates. Null draws everything.
   * Native animates a live alpha re-solve per frame; we rebuild on a throttle
   * instead, which is the only way to stay fast on a 20k+ note vault.
   */
  progressionLimit: number | null;

  /** "Filters" box - non-matching notes are dropped from the model */
  filterText: string;
  colorGroups: ColorGroup[];
  /**
   * Previous draw plus the live coordinates the user is looking at. Nodes that
   * still exist keep their position, so a filter change refines the layout
   * instead of throwing it away.
   */
  carry: { model: GraphModel; pos: Float32Array } | null;
}

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  showAttachments: false,
  showTags: false,
  showUnresolved: true,
  showOrphans: true,
  minTagUses: 1,
  maxNonFileNodes: 1200,
  clusterEnabled: true,
  clusterThreshold: 20,
  clusterMode: 'direct',
  maxVisibleNodes: 2500,
  revealOverrides: new Map<string, number>(),
  forcedCollapsed: new Set<string>(),
  scopePath: null,
  scopeDepth: 1,
  scopeForelinks: true,
  scopeBacklinks: true,
  scopeInterlinks: false,
  progressionLimit: null,
  filterText: '',
  colorGroups: [],
  carry: null,
};

interface Slot {
  folderId: number;
  overflow: boolean;
  revealOffset: number;
  nodeId: number;
  meta: ClusterMeta;
  /** bounded highest-degree members seen so far, kept sorted desc */
  top: { id: number; score: number }[];
  tags: Map<number, number>;
}

export interface BuildResult {
  model: GraphModel;
  ms: number;
  /** folders the node budget forced closed */
  budgetPromotions: number;
  filter: GraphQuery;
}

let revisionCounter = 0;

/**
 * Turn the vault's raw link graph into the graph that actually gets drawn.
 *
 * Phases: scope -> candidate files -> per-folder reveal/cluster plan -> node
 * budget -> node emission -> edge aggregation -> cluster metadata -> colour
 * groups -> geometry seeding.
 */
export function buildGraph(raw: RawGraph, options: BuildOptions): BuildResult {
  const started = performance.now();
  const back = BackIndex.for(raw);
  const filter = new GraphQuery(options.filterText, raw, back);
  const folderCount = raw.folders.length;

  // ---- 1. local-graph scoping --------------------------------------------
  const scope = options.scopePath ? localScope(raw, options.scopePath, options) : null;
  const inScope = scope ? scope.files : null;
  const scopeEdges = scope ? scope.edges : null;

  // ---- 2. candidate files ------------------------------------------------
  const active = new Uint8Array(raw.fileCount);
  const activeFolderCount = new Int32Array(folderCount);
  for (let i = 0; i < raw.fileCount; i++) {
    if (raw.isMd[i] === 0 && !options.showAttachments) continue;
    if (inScope && inScope[i] === 0) continue;
    if (!options.showOrphans && raw.orphan[i] === 1) continue;
    if (options.progressionLimit !== null && raw.dateRank[i] > options.progressionLimit) continue;
    if (!filter.empty && !filter.matchFile(i)) continue;
    active[i] = 1;
    activeFolderCount[raw.folderId[i]]++;
  }

  const subtreeActive = activeFolderCount.slice();
  const subtreeBytes = new Float64Array(folderCount);
  for (let i = 0; i < raw.fileCount; i++) if (active[i]) subtreeBytes[raw.folderId[i]] += raw.sizes[i];
  for (let i = folderCount - 1; i > 0; i--) {
    const parent = parentFolder(raw, i);
    if (parent >= 0) {
      subtreeActive[parent] += subtreeActive[i];
      subtreeBytes[parent] += subtreeBytes[i];
    }
  }

  // ---- 3. per-folder plan: cluster, partially reveal, or show everything --
  const wantCluster = new Uint8Array(folderCount);
  /** 1 when this folder's cluster also swallows every descendant folder */
  const absorbsSubtree = new Uint8Array(folderCount);
  const reveal = new Int32Array(folderCount);
  const clusterReason = new Array<ClusterMeta['reason']>(folderCount).fill('direct');
  const recursiveMode = options.clusterMode === 'recursive';
  for (let i = 0; i < folderCount; i++) {
    if (subtreeActive[i] === 0) {
      reveal[i] = 0;
      continue;
    }
    const path = raw.folders[i];
    const override = options.revealOverrides.get(path);
    if (override !== undefined) {
      wantCluster[i] = 0;
      reveal[i] = Math.max(0, override);
      clusterReason[i] = 'manual';
      continue;
    }
    if (options.forcedCollapsed.has(path)) {
      wantCluster[i] = subtreeActive[i] > 1 ? 1 : 0;
      absorbsSubtree[i] = wantCluster[i];
      reveal[i] = 0;
      clusterReason[i] = 'manual';
      continue;
    }
    if (!options.clusterEnabled) {
      wantCluster[i] = 0;
      reveal[i] = activeFolderCount[i];
      continue;
    }
    const measured = recursiveMode ? subtreeActive[i] : activeFolderCount[i];
    const entities = activeFolderCount[i] + childFoldersWithData(raw, i, subtreeActive);
    if (measured > options.clusterThreshold) {
      wantCluster[i] = 1;
      clusterReason[i] = 'direct';
    } else if (entities > options.clusterThreshold) {
      wantCluster[i] = 1;
      clusterReason[i] = 'entities';
    }
    absorbsSubtree[i] = wantCluster[i] === 1 && recursiveMode ? 1 : 0;
    reveal[i] = wantCluster[i] ? 0 : activeFolderCount[i];
  }

  /** nearest ancestor whose cluster swallows this folder, -1 when drawn itself */
  const absorbedBy = new Int32Array(folderCount).fill(-1);
  const computeAbsorption = (): void => {
    for (let i = 1; i < folderCount; i++) {
      const parent = parentFolder(raw, i);
      if (parent < 0) continue;
      absorbedBy[i] = absorbsSubtree[parent] === 1 ? parent : absorbedBy[parent];
    }
  };
  computeAbsorption();

  /** nodes contributed by a folder's visible subtree, bottom-up */
  const contribution = new Int32Array(folderCount);
  const computeContributions = (): void => {
    for (let i = folderCount - 1; i >= 0; i--) {
      if (subtreeActive[i] === 0 || absorbedBy[i] >= 0) {
        contribution[i] = 0;
        continue;
      }
      let total = 0;
      if (absorbsSubtree[i] === 1) {
        total = 1;
      } else if (wantCluster[i] === 1) {
        total = 1;
        for (let k = raw.folderChildOff[i]; k < raw.folderChildOff[i + 1]; k++) {
          total += contribution[raw.folderChildren[k]];
        }
      } else {
        const shown = Math.min(reveal[i], activeFolderCount[i]);
        total = shown + (activeFolderCount[i] - shown > 0 ? 1 : 0);
        for (let k = raw.folderChildOff[i]; k < raw.folderChildOff[i + 1]; k++) {
          total += contribution[raw.folderChildren[k]];
        }
      }
      contribution[i] = total;
    }
  };
  computeContributions();

  // ---- 4. node budget: fold the heaviest folders until the cap holds ------
  // Folding swallows a subtree, so one step never gives up more than half the
  // graph - otherwise the vault collapses into a single uninformative node.
  let budgetPromotions = 0;
  if (options.clusterEnabled) {
    for (let pass = 0; pass < 3; pass++) {
      if (contribution[0] <= options.maxVisibleNodes) break;
      const lastPass = pass === 2;
      const order: number[] = [];
      for (let i = 0; i < folderCount; i++) {
        if (subtreeActive[i] > 0 && absorbedBy[i] < 0 && absorbsSubtree[i] === 0) order.push(i);
      }
      order.sort((a, b) => contribution[b] - contribution[a]);
      let estimate = contribution[0];
      let changed = false;
      for (const i of order) {
        if (estimate <= options.maxVisibleNodes) break;
        const gain = contribution[i] - 1;
        if (gain < 2) continue;
        if (!lastPass && gain > estimate / 2) continue;
        wantCluster[i] = 1;
        absorbsSubtree[i] = 1;
        reveal[i] = 0;
        clusterReason[i] = 'budget';
        budgetPromotions++;
        estimate -= gain;
        changed = true;
      }
      if (!changed) break;
      computeAbsorption();
      computeContributions();
    }
  }

  // ---- 5. cluster slots ---------------------------------------------------
  const slots: Slot[] = [];
  const overflowSlotOf = new Int32Array(folderCount).fill(-1);

  const addSlot = (folderId: number, overflow: boolean, revealOffset: number, reason: ClusterMeta['reason']): Slot => {
    const path = raw.folders[folderId];
    const covering = overflow ? 0 : absorbsSubtree[folderId] === 1 ? subtreeActive[folderId] : activeFolderCount[folderId];
    const meta: ClusterMeta = {
      folder: path,
      label: '',
      fileCount: overflow ? Math.max(0, activeFolderCount[folderId] - revealOffset) : covering,
      directFiles: activeFolderCount[folderId],
      childFolders: overflow ? 0 : childFoldersWithData(raw, folderId, subtreeActive),
      internalLinks: 0,
      outWeight: 0,
      inWeight: 0,
      topFiles: [],
      topTags: [],
      reason,
      overflow,
      revealOffset,
      subtreeFiles: subtreeActive[folderId],
      sizeBytes: overflow ? 0 : subtreeBytes[folderId],
    };
    const slot: Slot = {
      folderId,
      overflow,
      revealOffset,
      nodeId: -1,
      meta,
      top: [],
      tags: new Map<number, number>(),
    };
    slots.push(slot);
    if (overflow) overflowSlotOf[folderId] = slots.length - 1;
    return slot;
  };

  for (let i = 0; i < folderCount; i++) {
    if (wantCluster[i] !== 1 || absorbedBy[i] >= 0) continue;
    addSlot(i, false, 0, clusterReason[i]);
  }
  // folders shown file by file but still hiding members behind an expansion cap
  for (let i = 0; i < folderCount; i++) {
    if (wantCluster[i] === 1 || absorbedBy[i] >= 0 || overflowSlotOf[i] >= 0) continue;
    const hidden = activeFolderCount[i] - reveal[i];
    if (hidden > 0) addSlot(i, true, reveal[i], 'budget');
  }

  // ---- 6. node emission ---------------------------------------------------
  const nodeKind: number[] = [];
  const nodeFileId: number[] = [];
  const nodeSlot: number[] = [];
  const nodeFolder: number[] = [];
  const labels: string[] = [];
  const paths: (string | null)[] = [];

  const addNode = (kind: number, fileId: number, slot: number, folder: number, label: string, path: string | null): number => {
    const id = nodeKind.length;
    nodeKind.push(kind);
    nodeFileId.push(fileId);
    nodeSlot.push(slot);
    nodeFolder.push(folder);
    labels.push(label);
    paths.push(path);
    return id;
  };

  const clusterNodeOf = new Int32Array(folderCount).fill(-1);
  const overflowNodeOf = new Int32Array(folderCount).fill(-1);
  for (let s = 0; s < slots.length; s++) {
    const slot = slots[s];
    slot.nodeId = addNode(NodeKind.Cluster, -1, s, slot.folderId, clusterLabel(raw, slot), slot.meta.folder);
    if (slot.overflow) overflowNodeOf[slot.folderId] = slot.nodeId;
    else clusterNodeOf[slot.folderId] = slot.nodeId;
  }

  /** node standing in for a folder's direct files, -1 when its files are drawn */
  const clusterOf = new Int32Array(folderCount).fill(-1);
  for (let i = 0; i < folderCount; i++) {
    if (absorbedBy[i] >= 0) clusterOf[i] = clusterNodeOf[absorbedBy[i]];
    else if (wantCluster[i] === 1) clusterOf[i] = clusterNodeOf[i];
  }

  /** rank of each member inside its folder, highest degree first (only when capped) */
  const memberRank = new Int32Array(raw.fileCount).fill(-1);
  if (slots.some((s) => s.overflow)) {
    const byFolder = new Map<number, number[]>();
    for (let i = 0; i < raw.fileCount; i++) {
      if (!active[i]) continue;
      const f = raw.folderId[i];
      if (overflowSlotOf[f] < 0) continue;
      const list = byFolder.get(f);
      if (list) list.push(i);
      else byFolder.set(f, [i]);
    }
    const score = (i: number) => raw.outWeight[i] + raw.inWeight[i];
    for (const [, list] of byFolder) {
      list.sort((a, b) => score(b) - score(a));
      for (let r = 0; r < list.length; r++) memberRank[list[r]] = r;
    }
  }

  const repOfFile = new Int32Array(raw.fileCount).fill(-1);
  const focusFile = scope ? scope.root : -1;
  for (let i = 0; i < raw.fileCount; i++) {
    if (!active[i]) continue;
    const folder = raw.folderId[i];
    if (i !== focusFile) {
      const clustered = clusterOf[folder];
      if (clustered >= 0) {
        repOfFile[i] = clustered;
        continue;
      }
      if (overflowNodeOf[folder] >= 0 && memberRank[i] >= reveal[folder]) {
        repOfFile[i] = overflowNodeOf[folder];
        continue;
      }
    }
    repOfFile[i] = addNode(
      raw.isMd[i] === 1 ? NodeKind.File : NodeKind.Attachment,
      i,
      -1,
      folder,
      raw.names[i],
      raw.paths[i],
    );
  }

  // tag / unresolved nodes, ranked by the files that are actually drawn
  const tagRep = new Int32Array(raw.tagNames.length).fill(-1);
  const overflowCounts: { kind: number; count: number }[] = [];
  if (options.showTags) {
    const usage = new Int32Array(raw.tagNames.length);
    for (let e = 0; e < raw.ts.length; e++) {
      if (!active[raw.ts[e]]) continue;
      usage[raw.tt[e]]++;
    }
    const minUses = Math.max(1, options.minTagUses);
    const order: number[] = [];
    for (let t = 0; t < raw.tagNames.length; t++) {
      if (usage[t] >= minUses) order.push(t);
    }
    order.sort((a, b) => usage[b] - usage[a]);
    const keep = order.slice(0, options.maxNonFileNodes);
    if (order.length > keep.length) overflowCounts.push({ kind: NodeKind.Tag, count: order.length - keep.length });
    for (const t of keep) tagRep[t] = addNode(NodeKind.Tag, -1, -1, -1, raw.tagNames[t], null);
  }

  const unresRep = new Int32Array(raw.unresolvedNames.length).fill(-1);
  if (options.showUnresolved) {
    const usage = new Float32Array(raw.unresolvedNames.length);
    for (let e = 0; e < raw.us.length; e++) {
      if (!active[raw.us[e]]) continue;
      usage[raw.ut[e]] += raw.uw[e];
    }
    const order: number[] = [];
    for (let u = 0; u < raw.unresolvedNames.length; u++) {
      if (usage[u] > 0) order.push(u);
    }
    order.sort((a, b) => usage[b] - usage[a]);
    const keep = order.slice(0, options.maxNonFileNodes);
    if (order.length > keep.length) overflowCounts.push({ kind: NodeKind.Unresolved, count: order.length - keep.length });
    for (const u of keep) unresRep[u] = addNode(NodeKind.Unresolved, -1, -1, -1, raw.unresolvedNames[u], null);
  }

  const nodeTotal = nodeKind.length;

  // ---- 7. edge aggregation ------------------------------------------------
  const bundles = new Map<number, { w: number; k: number }>();
  const addEdge = (a: number, b: number, weight: number, kind: number): void => {
    if (a < 0 || b < 0) return;
    if (a === b) {
      const slot = nodeSlot[a];
      if (slot >= 0) slots[slot].meta.internalLinks += weight;
      return;
    }
    const key = a * nodeTotal + b;
    const hit = bundles.get(key);
    if (hit) {
      hit.w += weight;
      hit.k |= kind;
    } else bundles.set(key, { w: weight, k: kind });
  };

  for (let e = 0; e < raw.es.length; e++) {
    if (scopeEdges && scopeEdges[e] === 0) continue;
    const s = raw.es[e];
    if (!active[s]) continue;
    const t = raw.et[e];
    if (!active[t]) continue;
    addEdge(repOfFile[s], repOfFile[t], raw.ew[e], raw.ek[e]);
  }
  for (let e = 0; e < raw.us.length; e++) {
    const s = raw.us[e];
    if (!active[s]) continue;
    addEdge(repOfFile[s], unresRep[raw.ut[e]], raw.uw[e], EdgeKind.Link);
  }
  const seenTagEdge = new Set<number>();
  for (let e = 0; e < raw.ts.length; e++) {
    const s = raw.ts[e];
    if (!active[s]) continue;
    const t = raw.tt[e];
    const target = tagRep[t];
    if (target < 0) continue;
    const a = repOfFile[s];
    if (a < 0) continue;
    const slotIdx = nodeSlot[a];
    if (slotIdx >= 0) {
      const dedupe = a * raw.tagNames.length + t;
      if (seenTagEdge.has(dedupe)) continue;
      seenTagEdge.add(dedupe);
      const tags = slots[slotIdx].tags;
      tags.set(t, (tags.get(t) ?? 0) + 1);
    }
    addEdge(a, target, 1, EdgeKind.Tag);
  }

  // ---- 8. cluster membership metadata -------------------------------------
  const score = (i: number) => raw.outWeight[i] + raw.inWeight[i];
  for (let i = 0; i < raw.fileCount; i++) {
    if (!active[i]) continue;
    const rep = repOfFile[i];
    if (rep < 0) continue;
    const slotIdx = nodeSlot[rep];
    if (slotIdx < 0) continue;
    const slot = slots[slotIdx];
    const s = score(i);
    const top = slot.top;
    if (top.length < 10 || s > top[top.length - 1].score) {
      top.push({ id: i, score: s });
      let k = top.length - 1;
      while (k > 0 && top[k - 1].score < top[k].score) {
        const tmp = top[k - 1];
        top[k - 1] = top[k];
        top[k] = tmp;
        k--;
      }
      if (top.length > 10) top.length = 10;
    }
  }
  for (const slot of slots) {
    slot.meta.topFiles = slot.top.slice(0, 6).map((entry) => ({
      path: raw.paths[entry.id],
      name: raw.names[entry.id],
      deg: Math.round(entry.score * 100) / 100,
    }));
    if (slot.tags.size) {
      slot.meta.topTags = [...slot.tags.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([t, count]) => ({ tag: raw.tagNames[t], count }));
    }
    slot.meta.label = clusterLabel(raw, slot);
    labels[slot.nodeId] = slot.meta.label;
  }

  // ---- 9. flush bundles --------------------------------------------------
  const eu: number[] = [];
  const ev: number[] = [];
  const ew: number[] = [];
  const ek: number[] = [];
  for (const [key, b] of bundles) {
    const a = Math.floor(key / nodeTotal);
    const c = key - a * nodeTotal;
    if (a >= nodeTotal || c >= nodeTotal || a === c) continue;
    const aggregate = nodeKind[a] === NodeKind.Cluster || nodeKind[c] === NodeKind.Cluster;
    eu.push(a);
    ev.push(c);
    ew.push(b.w);
    ek.push(aggregate ? b.k | EdgeKind.Aggregate : b.k);
    if (aggregate) {
      const from = nodeSlot[a];
      const to = nodeSlot[c];
      if (from >= 0) slots[from].meta.outWeight += b.w;
      if (to >= 0) slots[to].meta.inWeight += b.w;
    }
  }

  // ---- 10. colour groups ---------------------------------------------------
  const group = new Int32Array(nodeTotal).fill(-1);
  if (options.colorGroups.length > 0) {
    const activeGroups: { index: number; query: GraphQuery }[] = [];
    for (let g = 0; g < options.colorGroups.length; g++) {
      const q = new GraphQuery(options.colorGroups[g].query, raw, back);
      if (!q.empty) activeGroups.push({ index: g, query: q });
    }
    if (activeGroups.length > 0) {
      const slotTags = slots.map((s) => s.meta.topTags.map((t) => t.tag));
      const ctx = {
        fileId: -1,
        kind: 0,
        label: '',
        path: null as string | null,
        folder: '',
        tags: undefined as string[] | undefined,
      };
      for (let i = 0; i < nodeTotal; i++) {
        const slotIdx = nodeSlot[i];
        const folderIndex = nodeFolder[i];
        ctx.fileId = nodeFileId[i];
        ctx.kind = nodeKind[i];
        ctx.label = labels[i];
        ctx.path = paths[i];
        ctx.folder = folderIndex >= 0 && folderIndex < raw.folders.length ? raw.folders[folderIndex] : '';
        ctx.tags = slotIdx >= 0 ? slotTags[slotIdx] : undefined;
        for (let g = 0; g < activeGroups.length; g++) {
          if (activeGroups[g].query.matchNode(ctx)) {
            group[i] = activeGroups[g].index;
            break;
          }
        }
      }
    }
  }

  // ---- 11. typed arrays, adjacency, geometry ------------------------------
  const n = nodeTotal;
  const kind = Uint8Array.from(nodeKind);
  const fileIdArr = Int32Array.from(nodeFileId);
  const clusterIdArr = Int32Array.from(nodeSlot);
  const folderIdArr = Int32Array.from(nodeFolder);
  const degree = new Float32Array(n);
  const inDegree = new Float32Array(n);
  const outDegree = new Float32Array(n);
  const m = eu.length;
  const euOut = Int32Array.from(eu);
  const evOut = Int32Array.from(ev);
  const ewOut = Float32Array.from(ew);
  const ekOut = Uint8Array.from(ek);
  for (let i = 0; i < m; i++) {
    degree[euOut[i]] += ewOut[i];
    degree[evOut[i]] += ewOut[i];
    outDegree[euOut[i]] += ewOut[i];
    inDegree[evOut[i]] += ewOut[i];
  }

  const adjOff = new Int32Array(n + 1);
  for (let i = 0; i < m; i++) {
    adjOff[euOut[i] + 1]++;
    adjOff[evOut[i] + 1]++;
  }
  for (let i = 0; i < n; i++) adjOff[i + 1] += adjOff[i];
  const adjNode = new Int32Array(adjOff[n]);
  const adjEdge = new Int32Array(adjOff[n]);
  {
    const cursor = adjOff.slice(0, n);
    for (let i = 0; i < m; i++) {
      adjNode[cursor[euOut[i]]] = evOut[i];
      adjEdge[cursor[euOut[i]]++] = i;
      adjNode[cursor[evOut[i]]] = euOut[i];
      adjEdge[cursor[evOut[i]]++] = i;
    }
  }

  // Obsidian's node radius counts *distinct* neighbours, so reciprocal edges
  // and multi-links must collapse to one.
  const neighbors = new Float32Array(n);
  {
    const seenAt = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      let cnt = 0;
      for (let k = adjOff[i]; k < adjOff[i + 1]; k++) {
        const w = adjNode[k];
        if (seenAt[w] === i) continue;
        seenAt[w] = i;
        cnt++;
      }
      neighbors[i] = cnt;
    }
  }

  // A local graph sizes its nodes by BFS hop weight, not by degree.
  const sizeWeight = neighbors.slice();
  if (scope) {
    const depth = Math.max(1, options.scopeDepth);
    for (let i = 0; i < n; i++) {
      const file = fileIdArr[i];
      if (file < 0) continue;
      const hop = scope.hops[file];
      if (hop < 0) continue;
      sizeWeight[i] = hop === 0 ? 30 : Math.max(0, 30 - (30 / depth) * hop);
    }
  }

  const pos = new Float32Array(n * 2);
  seedPositions(raw, kind, clusterIdArr, folderIdArr, labels, slots, paths, subtreeActive, pos);

  let shownFiles = 0;
  let collapsedFiles = 0;
  for (let i = 0; i < n; i++) {
    if (kind[i] === NodeKind.File || kind[i] === NodeKind.Attachment) shownFiles++;
    else if (kind[i] === NodeKind.Cluster) collapsedFiles += slots[clusterIdArr[i]].meta.fileCount;
  }

  const model: GraphModel = {
    revision: ++revisionCounter,
    nodeCount: n,
    edgeCount: m,
    kind,
    degree,
    neighbors,
    sizeWeight,
    inDegree,
    outDegree,
    fileId: fileIdArr,
    clusterId: clusterIdArr,
    label: labels,
    path: paths,
    group,
    folderId: folderIdArr,
    pos,
    pinned: new Uint8Array(n),
    fx: new Float32Array(n),
    fy: new Float32Array(n),
    eu: euOut,
    ev: evOut,
    ew: ewOut,
    ek: ekOut,
    adjOff,
    adjNode,
    adjEdge,
    clusters: slots.map((s) => s.meta),
    overflow: overflowCounts,
    stats: {
      files: raw.fileCount,
      shownFiles,
      rawEdges: raw.edgeCount,
      shownEdges: m,
      clusters: slots.length,
      collapsedFiles,
    },
  };

  if (options.carry) applyCarry(options.carry, model);

  return { model, ms: performance.now() - started, budgetPromotions, filter };
}

/**
 * A local graph pane with no file attached draws nothing. The engine needs a
 * well-formed model to keep its buffers and the worker happy, not a null.
 */
export function emptyGraphModel(): GraphModel {
  const empty = new Float32Array(0);
  const emptyIndex = new Int32Array(0);
  return {
    revision: ++revisionCounter,
    nodeCount: 0,
    edgeCount: 0,
    kind: new Uint8Array(0),
    degree: empty,
    neighbors: empty,
    sizeWeight: empty,
    inDegree: empty,
    outDegree: empty,
    fileId: emptyIndex,
    clusterId: emptyIndex,
    label: [],
    path: [],
    group: emptyIndex,
    folderId: emptyIndex,
    pos: new Float32Array(2),
    pinned: new Uint8Array(0),
    fx: empty,
    fy: empty,
    eu: emptyIndex,
    ev: emptyIndex,
    ew: empty,
    ek: new Uint8Array(0),
    adjOff: new Int32Array(1),
    adjNode: emptyIndex,
    adjEdge: emptyIndex,
    clusters: [],
    overflow: [],
    stats: {
      files: 0,
      shownFiles: 0,
      rawEdges: 0,
      shownEdges: 0,
      clusters: 0,
      collapsedFiles: 0,
    },
  };
}

/**
 * Stable identity for a drawn node across rebuilds: files by path, clusters by
 * folder (and reveal offset, since an overflow node is a different thing), tags
 * and unresolved links by label.
 */
export function nodeKey(model: GraphModel, i: number): string {
  const kind = model.kind[i];
  if (kind === NodeKind.Cluster) {
    const meta = model.clusters[model.clusterId[i]];
    return meta.overflow ? `c:${meta.folder}+${meta.revealOffset}` : `c:${meta.folder}`;
  }
  if (kind === NodeKind.Tag) return `t:${model.label[i]}`;
  if (kind === NodeKind.Unresolved) return `u:${model.label[i]}`;
  return `f:${model.path[i] ?? model.label[i]}`;
}

function applyCarry(carry: { model: GraphModel; pos: Float32Array }, next: GraphModel): void {
  const prev = carry.model;
  const previous = carry.pos;
  if (previous.length < prev.nodeCount * 2) return;
  const byKey = new Map<string, number>();
  for (let i = 0; i < prev.nodeCount; i++) byKey.set(nodeKey(prev, i), i);
  for (let i = 0; i < next.nodeCount; i++) {
    const at = byKey.get(nodeKey(next, i));
    if (at === undefined) continue;
    next.pos[i * 2] = previous[at * 2];
    next.pos[i * 2 + 1] = previous[at * 2 + 1];
  }
}

function clusterLabel(raw: RawGraph, slot: Slot): string {
  const folder = raw.folders[slot.folderId] ?? '';
  const name = folder === '' ? 'Vault root' : folder.slice(folder.lastIndexOf('/') + 1);
  if (slot.overflow) return `${name}: ${slot.meta.fileCount.toLocaleString()} more`;
  return `${name} (${slot.meta.fileCount.toLocaleString()})`;
}

function parentFolder(raw: RawGraph, i: number): number {
  if (i <= 0) return -1;
  if (raw.folderParent && i < raw.folderParent.length) return raw.folderParent[i];
  const path = raw.folders[i];
  const cut = path.lastIndexOf('/');
  return raw.folderIndex.get(cut < 0 ? '' : path.slice(0, cut)) ?? -1;
}

function childFoldersWithData(raw: RawGraph, i: number, subtreeActive: Int32Array): number {
  let count = 0;
  for (let k = raw.folderChildOff[i]; k < raw.folderChildOff[i + 1]; k++) {
    if (subtreeActive[raw.folderChildren[k]] > 0) count++;
  }
  return count;
}

interface Directed {
  outOff: Int32Array;
  outNode: Int32Array;
  outEdge: Int32Array;
  inOff: Int32Array;
  inNode: Int32Array;
  inEdge: Int32Array;
}

const directedCache = new WeakMap<RawGraph, Directed>();

function directed(raw: RawGraph): Directed {
  const hit = directedCache.get(raw);
  if (hit) return hit;
  const n = raw.fileCount;
  const m = raw.es.length;
  const outOff = new Int32Array(n + 1);
  const inOff = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    outOff[raw.es[e] + 1]++;
    inOff[raw.et[e] + 1]++;
  }
  for (let i = 0; i < n; i++) {
    outOff[i + 1] += outOff[i];
    inOff[i + 1] += inOff[i];
  }
  const outNode = new Int32Array(m);
  const outEdge = new Int32Array(m);
  const inNode = new Int32Array(m);
  const inEdge = new Int32Array(m);
  const outCursor = outOff.slice(0, n);
  const inCursor = inOff.slice(0, n);
  for (let e = 0; e < m; e++) {
    outNode[outCursor[raw.es[e]]] = raw.et[e];
    outEdge[outCursor[raw.es[e]]++] = e;
    inNode[inCursor[raw.et[e]]] = raw.es[e];
    inEdge[inCursor[raw.et[e]]++] = e;
  }
  const built: Directed = { outOff, outNode, outEdge, inOff, inNode, inEdge };
  directedCache.set(raw, built);
  return built;
}

interface LocalScope {
  files: Uint8Array;
  /** index of the focus file in `RawGraph`, -1 when it is gone from the vault */
  root: number;
  /** BFS round in which each file was reached; 0 for the focus, -1 when unseen */
  hops: Int32Array;
  /** raw edge index mask, null when every edge between neighbours is drawn */
  edges: Uint8Array | null;
}

/**
 * The native local graph BFS: expand one hop at a time along the enabled
 * directions and keep only the links that did the expanding, unless "Neighbor
 * links" is on - which is what makes a depth-1 graph read as a neighbourhood
 * rather than a clique.
 */
function localScope(raw: RawGraph, rootPath: string, options: BuildOptions): LocalScope {
  const files = new Uint8Array(raw.fileCount);
  const hops = new Int32Array(raw.fileCount).fill(-1);
  const d = directed(raw);
  const root = raw.pathIndex.get(rootPath) ?? -1;
  if (root < 0) return { files, root, hops, edges: options.scopeInterlinks ? null : new Uint8Array(raw.es.length) };
  const edges = options.scopeInterlinks ? null : new Uint8Array(raw.es.length);
  files[root] = 1;
  hops[root] = 0;
  let frontier = [root];
  const depth = Math.max(1, options.scopeDepth);
  for (let hop = 0; hop < depth; hop++) {
    const next: number[] = [];
    const add = (t: number, edge: number): void => {
      if (edges) edges[edge] = 1;
      if (files[t]) return;
      files[t] = 1;
      hops[t] = hop + 1;
      next.push(t);
    };
    for (const f of frontier) {
      if (options.scopeForelinks) {
        for (let k = d.outOff[f]; k < d.outOff[f + 1]; k++) add(d.outNode[k], d.outEdge[k]);
      }
      if (options.scopeBacklinks) {
        for (let k = d.inOff[f]; k < d.inOff[f + 1]; k++) add(d.inNode[k], d.inEdge[k]);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return { files, root, hops, edges };
}

/**
 * Deterministic seeding: every folder gets a stable polar anchor derived from its
 * path and how much it holds, and members start near their folder's anchor, so a
 * rebuild lands where the user left it and the layout settles in hundreds of
 * ticks rather than thousands.
 */
function seedPositions(
  raw: RawGraph,
  kind: Uint8Array,
  clusterId: Int32Array,
  folderId: Int32Array,
  labels: string[],
  slots: Slot[],
  paths: (string | null)[],
  subtreeActive: Int32Array,
  pos: Float32Array,
): void {
  const anchorCache = new Map<number, [number, number]>();
  const anchorOf = (folder: number): [number, number] => {
    const cached = anchorCache.get(folder);
    if (cached) return cached;
    const path = folder >= 0 && folder < raw.folders.length ? raw.folders[folder] : '';
    const h = hash32(path);
    const angle = ((h & 0xffff) / 0xffff) * Math.PI * 2;
    const load = folder >= 0 ? Math.sqrt(Math.max(1, subtreeActive[folder])) : 1;
    const radius = 24 + 9 * load + 40 * (((h >>> 16) & 0xff) / 255);
    const out: [number, number] = [Math.cos(angle) * radius, Math.sin(angle) * radius];
    anchorCache.set(folder, out);
    return out;
  };

  for (let i = 0; i < kind.length; i++) {
    let x: number;
    let y: number;
    if (kind[i] === NodeKind.Cluster) {
      const slot = slots[clusterId[i]];
      const base = anchorOf(slot.folderId);
      const len = Math.hypot(base[0], base[1]) || 1;
      const push = slot.overflow ? 80 : 0;
      x = (base[0] / len) * (len + push);
      y = (base[1] / len) * (len + push);
    } else if (kind[i] === NodeKind.Tag || kind[i] === NodeKind.Unresolved) {
      const h = hash32(labels[i]);
      const angle = ((h & 0xffff) / 0xffff) * Math.PI * 2;
      const radius = kind[i] === NodeKind.Tag ? 900 : 1300;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
    } else {
      const base = anchorOf(folderId[i]);
      const h = hash32(labels[i] + (paths[i] ?? ''));
      const jitter = 16 + (h % 900) / 40;
      const angle = ((h >>> 10) % 6283) / 1000;
      x = base[0] + Math.cos(angle) * jitter;
      y = base[1] + Math.sin(angle) * jitter;
    }
    pos[i * 2] = x;
    pos[i * 2 + 1] = y;
  }
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
