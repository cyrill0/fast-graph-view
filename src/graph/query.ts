import type { RawGraph } from './raw';
import { NodeKind } from './types';

/**
 * A practical subset of Obsidian's search language, evaluated against link-graph
 * facts only (the graph view never opens note bodies).
 *
 * Supported: whitespace AND, `or` / `|`, `-term`, `NOT`, parentheses,
 * `"quoted text"`, `tag:`, `path:` / `folder:`, `file:` / `name:`, `ext:`,
 * `link:` / `to:`, `backlink:` / `from:`, `is:orphan|cluster|file|attachment|tag|unresolved`.
 * Body-text and property terms (`[property]`, `line:`, `section:`) are not
 * available here because reading note bodies would dominate the frame budget.
 */

type Term = (ctx: MatchContext) => boolean;

export interface MatchContext {
  fileId: number;
  kind: number;
  label: string;
  path: string | null;
  folder: string;
  /** aggregated tag names, present for cluster nodes */
  tags?: string[];
}

export class GraphQuery {
  private term: Term | null = null;
  private readonly raw: RawGraph;
  readonly error: string | null;
  readonly usedTagFacts: boolean;
  readonly usedLinkFacts: boolean;

  constructor(
    readonly text: string,
    raw: RawGraph,
    back: BackIndex,
  ) {
    this.raw = raw;
    this.usedTagFacts = /(^|\s)-?(tag:|#)/i.test(text);
    this.usedLinkFacts = /(^|\s)-?(link:|to:|from:|backlink:)/i.test(text);
    let error: string | null = null;
    if (text.trim()) {
      try {
        this.term = parse(text, raw, back);
      } catch (e) {
        this.term = null;
        error = e instanceof Error ? e.message : String(e);
      }
    }
    this.error = error;
  }

  get empty(): boolean {
    return this.term === null;
  }

  matchFile(fileId: number): boolean {
    if (!this.term) return true;
    const raw = this.raw;
    const path = raw.paths[fileId];
    const cut = path.lastIndexOf('/');
    return this.term({
      fileId,
      kind: raw.isMd[fileId] ? NodeKind.File : NodeKind.Attachment,
      label: raw.names[fileId],
      path,
      folder: cut < 0 ? '' : path.slice(0, cut),
    });
  }

  matchNode(node: {
    kind: number;
    label: string;
    path: string | null;
    fileId: number;
    folder: string;
    tags?: string[];
  }): boolean {
    if (!this.term) return true;
    if (node.fileId >= 0) return this.matchFile(node.fileId);
    return this.term({
      fileId: -1,
      kind: node.kind,
      label: node.label,
      path: node.path,
      folder: node.path ?? node.folder,
      tags: node.tags,
    });
  }
}

/** reverse link index, built only when a query needs `backlink:` / `from:` */
export class BackIndex {
  private sources: Int32Array[] | null = null;

  constructor(private readonly raw: RawGraph) {}

  ensure(): void {
    if (this.sources) return;
    const n = this.raw.fileCount;
    const lists: number[][] = new Array(n);
    for (let i = 0; i < n; i++) lists[i] = [];
    for (let e = 0; e < this.raw.es.length; e++) lists[this.raw.et[e]].push(this.raw.es[e]);
    this.sources = lists.map((l) => Int32Array.from(l));
  }

  /** file ids linking *to* `fileId` */
  in(fileId: number): Int32Array {
    this.ensure();
    return this.sources![fileId] ?? EMPTY_INT;
  }
}

const EMPTY_INT = new Int32Array(0);

// ---- parser ---------------------------------------------------------------

interface Token {
  type: 'term' | 'not' | 'or' | 'lparen' | 'rparen';
  value?: string;
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (c === '|') {
      out.push({ type: 'or' });
      i++;
      continue;
    }
    if (c === '(') {
      out.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      out.push({ type: 'rparen' });
      i++;
      continue;
    }
    // read a word, honouring quotes
    let word = '';
    while (i < src.length && src[i] !== ' ' && src[i] !== '(' && src[i] !== ')') {
      if (src[i] === '"') {
        i++;
        const start = i;
        while (i < src.length && src[i] !== '"') i++;
        word += src.slice(start, i);
        i++;
        continue;
      }
      if (src[i] === '|') break;
      word += src[i];
      i++;
    }
    if (!word) continue;
    if (/^or$/i.test(word)) out.push({ type: 'or' });
    else if (/^not$/i.test(word)) out.push({ type: 'not' });
    else out.push({ type: 'term', value: word });
  }
  return out;
}

/** recursive descent: sequence = AND, `or` binds looser than implicit AND */
function parse(src: string, raw: RawGraph, back: BackIndex): Term {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const parsePrimary = (): Term => {
    const t = peek();
    if (!t) throw new Error('unexpected end of query');
    if (t.type === 'lparen') {
      pos++;
      const inner = parseOr();
      if (peek()?.type === 'rparen') pos++;
      else throw new Error('missing )');
      return inner;
    }
    if (t.type === 'not') {
      pos++;
      const inner = parsePrimary();
      return (ctx) => !inner(ctx);
    }
    if (t.type === 'rparen') throw new Error('unexpected )');
    pos++;
    return leaf(t.value!, raw, back);
  };

  const parseSequence = (): Term => {
    const parts: Term[] = [];
    while (pos < tokens.length) {
      const t = peek();
      if (t.type === 'rparen' || t.type === 'or') break;
      let negate = false;
      if (t.type === 'not') {
        pos++;
        negate = true;
      }
      const term = parsePrimary();
      parts.push(negate ? (ctx) => !term(ctx) : term);
    }
    if (!parts.length) return () => true;
    if (parts.length === 1) return parts[0];
    return (ctx) => parts.every((p) => p(ctx));
  };

  const parseOr = (): Term => {
    const branches: Term[] = [parseSequence()];
    while (peek()?.type === 'or') {
      pos++;
      branches.push(parseSequence());
    }
    if (branches.length === 1) return branches[0];
    return (ctx) => branches.some((b) => b(ctx));
  };

  // top level: implicit AND with `or` / `|` binding looser
  pos = 0;
  const tree = parseOr();
  if (pos < tokens.length) throw new Error('unbalanced query');
  return tree;
}

function leaf(word: string, raw: RawGraph, back: BackIndex): Term {
  let text = word;
  let negate = false;
  if (text.startsWith('-') && text.length > 1) {
    negate = true;
    text = text.slice(1);
  }
  const inner = atom(text, raw, back);
  return negate ? (ctx) => !inner(ctx) : inner;
}

function atom(word: string, raw: RawGraph, back: BackIndex): Term {
  const lowered = word.toLowerCase();
  const colon = word.indexOf(':');
  const prefix = colon > 0 ? word.slice(0, colon).toLowerCase() : null;
  const value = colon > 0 ? stripQuotes(word.slice(colon + 1)) : '';
  const valueLower = value.toLowerCase();

  switch (prefix) {
    case 'tag':
      return tagTerm(value.startsWith('#') ? value : '#' + value, raw);
    case 'path':
    case 'folder': {
      const needle = valueLower;
      return (ctx) => {
        const hay = (ctx.path ?? ctx.label).toLowerCase();
        if (prefix === 'folder') return folderOf(hay).startsWith(needle) || folderOf(hay) === needle;
        return hay.includes(needle);
      };
    }
    case 'file':
    case 'name': {
      const needle = valueLower;
      return (ctx) => {
        const base = baseName(ctx.path ?? ctx.label).toLowerCase();
        return base.includes(needle);
      };
    }
    case 'ext':
      return (ctx) => ctx.kind !== NodeKind.Cluster && extensionOf(ctx.path ?? ctx.label).toLowerCase() === valueLower;
    case 'is': {
      switch (valueLower) {
        case 'orphan':
          return (ctx) => ctx.fileId >= 0 && raw.orphan[ctx.fileId] === 1;
        case 'cluster':
          return (ctx) => ctx.kind === NodeKind.Cluster;
        case 'file':
          return (ctx) => ctx.kind === NodeKind.File;
        case 'attachment':
          return (ctx) => ctx.kind === NodeKind.Attachment;
        case 'tag':
          return (ctx) => ctx.kind === NodeKind.Tag;
        case 'unresolved':
          return (ctx) => ctx.kind === NodeKind.Unresolved;
        default:
          return () => false;
      }
    }
    case 'link':
    case 'to': {
      const needle = valueLower;
      return (ctx) => ctx.fileId >= 0 && hasOutgoingMatch(raw, ctx.fileId, needle);
    }
    case 'backlink':
    case 'from': {
      const needle = valueLower;
      return (ctx) => {
        if (ctx.fileId < 0) return false;
        for (const s of back.in(ctx.fileId)) {
          if (raw.paths[s].toLowerCase().includes(needle) || raw.names[s].toLowerCase().includes(needle)) return true;
        }
        return false;
      };
    }
    default:
      break;
  }

  if (word.startsWith('#')) return tagTerm(word, raw);

  const needle = lowered;
  return (ctx) => {
    if (ctx.label.toLowerCase().includes(needle)) return true;
    if (ctx.path && ctx.path.toLowerCase().includes(needle)) return true;
    return false;
  };
}

interface Outgoing {
  /** file ids linked to, CSR over files */
  linkOff: Int32Array;
  linkTo: Int32Array;
  /** unresolved link keys, CSR over files */
  unresOff: Int32Array;
  unresTo: Int32Array;
}

const outgoingCache = new WeakMap<RawGraph, Outgoing>();

function outgoing(raw: RawGraph): Outgoing {
  const hit = outgoingCache.get(raw);
  if (hit) return hit;
  const n = raw.fileCount;
  const linkDeg = new Int32Array(n + 1);
  const unresDeg = new Int32Array(n + 1);
  for (let e = 0; e < raw.es.length; e++) linkDeg[raw.es[e] + 1]++;
  for (let e = 0; e < raw.us.length; e++) unresDeg[raw.us[e] + 1]++;
  for (let i = 0; i < n; i++) {
    linkDeg[i + 1] += linkDeg[i];
    unresDeg[i + 1] += unresDeg[i];
  }
  const linkTo = new Int32Array(linkDeg[n]);
  const unresTo = new Int32Array(unresDeg[n]);
  {
    const cursor = linkDeg.slice(0, n);
    for (let e = 0; e < raw.es.length; e++) linkTo[cursor[raw.es[e]]++] = raw.et[e];
  }
  {
    const cursor = unresDeg.slice(0, n);
    for (let e = 0; e < raw.us.length; e++) unresTo[cursor[raw.us[e]]++] = raw.ut[e];
  }
  const built: Outgoing = { linkOff: linkDeg, linkTo, unresOff: unresDeg, unresTo };
  outgoingCache.set(raw, built);
  return built;
}

/** does `fileId` link to anything whose path, name or link text contains `needle`? */
function hasOutgoingMatch(raw: RawGraph, fileId: number, needle: string): boolean {
  const o = outgoing(raw);
  for (let k = o.linkOff[fileId]; k < o.linkOff[fileId + 1]; k++) {
    const t = o.linkTo[k];
    if (raw.paths[t].toLowerCase().includes(needle) || raw.names[t].toLowerCase().includes(needle)) return true;
  }
  for (let k = o.unresOff[fileId]; k < o.unresOff[fileId + 1]; k++) {
    if (raw.unresolvedNames[o.unresTo[k]].toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** `tag:#x` - matches tag nodes, a file's own tags, and a cluster's aggregated tags */
function tagTerm(raw: string, graph: RawGraph): Term {
  const needle = raw.toLowerCase();
  const hits = (name: string): boolean => {
    const lower = name.toLowerCase();
    return lower === needle || lower.startsWith(needle + '/');
  };
  return (ctx) => {
    if (ctx.kind === NodeKind.Tag) return hits(ctx.label);
    if (ctx.fileId >= 0) {
      for (let k = graph.fileTagOff[ctx.fileId]; k < graph.fileTagOff[ctx.fileId + 1]; k++) {
        if (hits(graph.tagNames[graph.fileTagId[k]])) return true;
      }
      return false;
    }
    if (ctx.tags) for (const t of ctx.tags) if (hits(t)) return true;
    return false;
  };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  const file = cut < 0 ? path : path.slice(cut + 1);
  const dot = file.lastIndexOf('.');
  return dot <= 0 ? file : file.slice(0, dot);
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1);
}

export function compileQuery(raw: RawGraph, text: string, back: BackIndex): GraphQuery {
  return new GraphQuery(text, raw, back);
}
