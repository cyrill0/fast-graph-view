import type { App, TFile } from 'obsidian';
import { EdgeKind } from './types';

const EMPTY: number[] = [];

/**
 * Flat, cache-shaped view of the vault's link graph.
 *
 * Built only from `metadataCache` - note bodies are never read - so a 24k-note
 * vault costs tens of milliseconds rather than seconds. Cached by the plugin and
 * re-derived only when the vault structure or a note's cache actually changes.
 */
export class RawGraph {
  /** vault paths, index-aligned with every per-file array below */
  paths: string[] = [];
  /** basename without extension, same order as `paths` */
  names: string[] = [];
  pathIndex = new Map<string, number>();
  isMd: Uint8Array = new Uint8Array(0);
  /** byte size per file, kept as cluster/node metadata */
  sizes: Float32Array = new Float32Array(0);
  /** timelapse order: rank by min(ctime, mtime), oldest note first */
  dateRank: Int32Array = new Int32Array(0);

  folders: string[] = [];
  folderIndex = new Map<string, number>();
  /** folder id per file */
  folderId: Int32Array = new Int32Array(0);
  /** files sitting directly inside each folder */
  folderDirectFiles: Int32Array = new Int32Array(0);
  /** files inside each folder subtree */
  folderAllFiles: Int32Array = new Int32Array(0);
  /** CSR children lists over `folders`; parents always have a lower index */
  folderChildOff: Int32Array = new Int32Array(0);
  folderChildren: Int32Array = new Int32Array(0);

  /** file -> file edges */
  es: Int32Array = new Int32Array(0);
  et: Int32Array = new Int32Array(0);
  ew: Float32Array = new Float32Array(0);
  ek: Uint8Array = new Uint8Array(0);

  /** unresolved link node names + file -> unresolved edges */
  unresolvedNames: string[] = [];
  unresolvedIndex = new Map<string, number>();
  us: Int32Array = new Int32Array(0);
  ut: Int32Array = new Int32Array(0);
  uw: Float32Array = new Float32Array(0);

  /** tag node names + file -> tag edges */
  tagNames: string[] = [];
  tagIndex = new Map<string, number>();
  ts: Int32Array = new Int32Array(0);
  tt: Int32Array = new Int32Array(0);

  /** CSR of tag ids per file, for `tag:` filters */
  fileTagOff: Int32Array = new Int32Array(0);
  fileTagId: Int32Array = new Int32Array(0);

  /** link weight leaving/entering each file (unresolved counts as outgoing) */
  outWeight: Float32Array = new Float32Array(0);
  inWeight: Float32Array = new Float32Array(0);
  /** 1 when the file links to nothing and nothing links to it */
  orphan: Uint8Array = new Uint8Array(0);

  fileCount = 0;
  edgeCount = 0;
  buildMs = 0;
  /** bumped whenever anything structural changed */
  revision = 0;

  static build(app: App): RawGraph {
    const started = performance.now();
    const g = new RawGraph();
    const cache = app.metadataCache;

    const files: TFile[] = app.vault.getFiles().slice().sort(comparePath);

    // ---- folders: root first, then every ancestor, ordered by depth -------
    const folderSet = new Set<string>(['']);
    for (const f of files) {
      const cut = f.path.lastIndexOf('/');
      if (cut < 0) continue;
      let cur = f.path.slice(0, cut);
      for (;;) {
        if (folderSet.has(cur)) break;
        folderSet.add(cur);
        const up = cur.lastIndexOf('/');
        if (up < 0) break;
        cur = cur.slice(0, up);
      }
    }
    const folders = [...folderSet].sort(
      (a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
    const folderIndex = new Map<string, number>();
    folders.forEach((f, i) => folderIndex.set(f, i));
    const folderDirect = new Int32Array(folders.length);

    // ---- files ------------------------------------------------------------
    const paths = new Array<string>(files.length);
    const names = new Array<string>(files.length);
    const isMd = new Uint8Array(files.length);
    const sizes = new Float32Array(files.length);
    const fileIdOfFolder = new Int32Array(files.length);
    const pathIndex = new Map<string, number>();
    const dates = new Float64Array(files.length);
    const dateRank = new Int32Array(files.length);

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      paths[i] = f.path;
      names[i] = f.basename;
      isMd[i] = f.extension === 'md' ? 1 : 0;
      sizes[i] = f.stat?.size ?? 0;
      const stat = f.stat;
      dates[i] = stat ? Math.min(stat.ctime, stat.mtime) : i;
      pathIndex.set(f.path, i);
      const cut = f.path.lastIndexOf('/');
      const folder = folderIndex.get(cut < 0 ? '' : f.path.slice(0, cut))!;
      fileIdOfFolder[i] = folder;
      folderDirect[folder]++;
    }

    // timelapse order: oldest first, stable for equal timestamps
    const order = Array.from({ length: files.length }, (_, i) => i);
    order.sort((a, b) => dates[a] - dates[b] || a - b);
    for (let rank = 0; rank < order.length; rank++) dateRank[order[rank]] = rank;

    // ---- folder subtree sizes and child lists -----------------------------
    const folderAll = folderDirect.slice();
    for (let i = folders.length - 1; i > 0; i--) {
      const parent = parentOf(folders, i, folderIndex);
      if (parent >= 0) folderAll[parent] += folderAll[i];
    }
    const childLists: number[][] = new Array(folders.length);
    for (let i = 0; i < folders.length; i++) childLists[i] = [];
    for (let i = 1; i < folders.length; i++) {
      const parent = parentOf(folders, i, folderIndex);
      if (parent >= 0) childLists[parent].push(i);
    }
    const folderChildOff = new Int32Array(folders.length + 1);
    let childTotal = 0;
    for (let i = 0; i < folders.length; i++) {
      folderChildOff[i] = childTotal;
      childTotal += childLists[i].length;
    }
    folderChildOff[folders.length] = childTotal;
    const folderChildren = new Int32Array(childTotal);
    {
      let k = 0;
      for (let i = 0; i < folders.length; i++)
        for (const c of childLists[i]) folderChildren[k++] = c;
    }

    // ---- file -> file edges ------------------------------------------------
    const esArr: number[] = [];
    const etArr: number[] = [];
    const ewArr: number[] = [];
    const ekArr: number[] = [];
    const outW = new Float32Array(files.length);
    const inW = new Float32Array(files.length);

    const resolved = cache.resolvedLinks as Record<string, Record<string, number>>;
    for (const srcPath in resolved) {
      const s = pathIndex.get(srcPath);
      if (s === undefined) continue;
      const targets = resolved[srcPath];
      for (const dstPath in targets) {
        const t = pathIndex.get(dstPath);
        if (t === undefined) continue;
        const w = targets[dstPath] > 0 ? targets[dstPath] : 1;
        esArr.push(s);
        etArr.push(t);
        ewArr.push(w);
        ekArr.push(EdgeKind.Link);
        outW[s] += w;
        inW[t] += w;
      }
    }

    // ---- unresolved links ---------------------------------------------------
    const unresolved = cache.unresolvedLinks as Record<string, Record<string, number>>;
    const usArr: number[] = [];
    const utArr: number[] = [];
    const uwArr: number[] = [];
    const unresNames: string[] = [];
    const unresIndex = new Map<string, number>();
    for (const srcPath in unresolved) {
      const s = pathIndex.get(srcPath);
      if (s === undefined) continue;
      const targets = unresolved[srcPath];
      for (const key in targets) {
        if (!key) continue;
        const w = targets[key] > 0 ? targets[key] : 1;
        let u = unresIndex.get(key);
        if (u === undefined) {
          u = unresNames.length;
          unresIndex.set(key, u);
          unresNames.push(key);
        }
        usArr.push(s);
        utArr.push(u);
        uwArr.push(w);
        outW[s] += w;
      }
    }

    // ---- tags ---------------------------------------------------------------
    const tagNames: string[] = [];
    const tagIndex = new Map<string, number>();
    const tsArr: number[] = [];
    const ttArr: number[] = [];
    const perFileTags: number[][] = new Array(files.length);
    for (let i = 0; i < files.length; i++) {
      const c = cache.getFileCache(files[i]);
      if (!c) {
        perFileTags[i] = EMPTY;
        continue;
      }
      const raw: string[] = [];
      if (c.tags) for (const t of c.tags) if (t.tag) raw.push(t.tag);
      const fm = c.frontmatter as Record<string, unknown> | undefined;
      if (fm) {
        pushTagValues(fm['tag'], raw);
        pushTagValues(fm['tags'], raw);
      }
      if (!raw.length) {
        perFileTags[i] = EMPTY;
        continue;
      }
      const ids: number[] = [];
      const seen = new Set<string>();
      for (let r = 0; r < raw.length; r++) {
        let name = raw[r];
        if (name[0] !== '#') name = '#' + name;
        if (seen.has(name)) continue;
        seen.add(name);
        let id = tagIndex.get(name);
        if (id === undefined) {
          id = tagNames.length;
          tagIndex.set(name, id);
          tagNames.push(name);
        }
        ids.push(id);
        tsArr.push(i);
        ttArr.push(id);
      }
      perFileTags[i] = ids;
    }
    const fileTagOff = new Int32Array(files.length + 1);
    let tagTotal = 0;
    for (let i = 0; i < files.length; i++) {
      fileTagOff[i] = tagTotal;
      tagTotal += perFileTags[i].length;
    }
    fileTagOff[files.length] = tagTotal;
    const fileTagId = new Int32Array(tagTotal);
    {
      let k = 0;
      for (let i = 0; i < files.length; i++) for (const t of perFileTags[i]) fileTagId[k++] = t;
    }

    // ---- commit -------------------------------------------------------------
    g.paths = paths;
    g.names = names;
    g.pathIndex = pathIndex;
    g.isMd = isMd;
    g.sizes = sizes;
    g.dateRank = dateRank;
    g.folders = folders;
    g.folderIndex = folderIndex;
    g.folderId = fileIdOfFolder;
    g.folderDirectFiles = folderDirect;
    g.folderAllFiles = folderAll;
    g.folderChildOff = folderChildOff;
    g.folderChildren = folderChildren;

    g.es = Int32Array.from(esArr);
    g.et = Int32Array.from(etArr);
    g.ew = Float32Array.from(ewArr);
    g.ek = Uint8Array.from(ekArr);
    g.edgeCount = esArr.length;
    g.outWeight = outW;
    g.inWeight = inW;

    g.unresolvedNames = unresNames;
    g.unresolvedIndex = unresIndex;
    g.us = Int32Array.from(usArr);
    g.ut = Int32Array.from(utArr);
    g.uw = Float32Array.from(uwArr);

    g.tagNames = tagNames;
    g.tagIndex = tagIndex;
    g.ts = Int32Array.from(tsArr);
    g.tt = Int32Array.from(ttArr);
    g.fileTagOff = fileTagOff;
    g.fileTagId = fileTagId;

    const orphan = new Uint8Array(files.length);
    for (let i = 0; i < files.length; i++) if (outW[i] === 0 && inW[i] === 0) orphan[i] = 1;
    g.orphan = orphan;

    g.fileCount = files.length;
    g.buildMs = performance.now() - started;
    g.revision++;
    return g;
  }

  /** how many files carry each tag id */
  tagCounts(): Map<number, number> {
    const counts = new Map<number, number>();
    for (let i = 0; i < this.tt.length; i++) {
      const t = this.tt[i];
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return counts;
  }
}

function comparePath(a: TFile, b: TFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function depth(folder: string): number {
  let d = 0;
  for (let i = 0; i < folder.length; i++) if (folder.charCodeAt(i) === 47) d++;
  return d;
}

function parentOf(folders: string[], i: number, map: Map<string, number>): number {
  const path = folders[i];
  if (path === '') return -1;
  const cut = path.lastIndexOf('/');
  return map.get(cut < 0 ? '' : path.slice(0, cut)) ?? -1;
}

function pushTagValues(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') into.push(item);
}
