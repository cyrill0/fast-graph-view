/** The two panes, and everything a pane owns around the engine.
 *
 *  Both views are thin: they keep the view-type contract the core plugin had
 *  (`graph` / `localgraph`, `{}` for the global leaf, `{file, options}` for a
 *  local one) and delegate the whole live graph to `GraphPresenter`, which is the
 *  engine's `EngineHost`, the panel's host, and the `HoverParent` page preview
 *  attaches its popover to.
 *
 *  The presenter is built in the view constructor because Obsidian can hand a
 *  restored leaf its state before `onOpen` runs - the core plugin does exactly
 *  the same with its engine.
 *
 *  Native puts the canvas, the panel and the popovers straight in `contentEl`
 *  with `position:relative; overflow:hidden; padding:0`, so we do too and the
 *  rules already in `app.css` keep applying.
 */

import {
  FileView,
  ItemView,
  Menu,
  Notice,
  TFile,
  type App,
  type HoverParent,
  type HoverPopover,
  type PaneType,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import type { RawGraph } from "../graph/raw";
import { VaultGraphSource } from "../graph/source";
import { NodeKind, type ClusterMeta } from "../graph/types";
import type { ClusterOptions, GraphOptions } from "../settings";
import { REVEAL_STEP, GraphEngine, type EngineHost, type EngineStats, type HitNode } from "./engine";
import { GraphControls, type ControlsHost } from "./controls";

export const GRAPH_VIEW_TYPE = "graph";
export const LOCAL_GRAPH_VIEW_TYPE = "localgraph";

/** Whatever `main.ts` can hand a pane: the shared snapshot and the persistence hooks. */
export interface GraphViewDeps {
  app: App;
  source: VaultGraphSource;
  /** the live global-graph options, shared by every global leaf */
  globalOptions: GraphOptions;
  cluster: ClusterOptions;
  /** the page-preview source id registered for these panes (`graph` under takeover) */
  hoverSource: string;
  /** write the global options back to wherever they are stored */
  saveGlobal(options: GraphOptions): void;
}

interface PresenterInit {
  contentEl: HTMLElement;
  leaf: WorkspaceLeaf;
  isLocal: boolean;
  deps: GraphViewDeps;
  options: GraphOptions;
  /** this view's options changed; a local leaf saves its layout, a global one its config */
  onSave(): void;
}

const REASON_TEXT: Record<ClusterMeta["reason"], string> = {
  direct: "over the folder threshold",
  entities: "over the folder threshold with its subfolders",
  budget: "hidden by the node budget",
  manual: "collapsed by hand",
};

/** Native's section order, so a `file-menu` from the graph lands where the core plugin's does. */
const MENU_SECTIONS = [
  "title", "open", "action", "info", "info.copy", "view", "view.linked", "system", "", "danger",
];

export class GraphPresenter implements EngineHost, ControlsHost, HoverParent {
  readonly engine: GraphEngine;
  readonly controls: GraphControls;
  readonly options: GraphOptions;
  readonly stageEl: HTMLElement;
  hoverPopover: HoverPopover | null = null;

  private readonly init: PresenterInit;
  private unsubscribe: (() => void) | null = null;
  private lastHoverLink: string | null = null;
  private stats: EngineStats | null = null;
  private transient: string | null = null;
  private statusEl: HTMLElement | null = null;
  private cardEl: HTMLElement | null = null;
  private cardFolder: string | null = null;
  private saveTimer = 0;
  private loaded = false;

  constructor(init: PresenterInit) {
    this.init = init;
    this.options = init.options;
    this.stageEl = init.contentEl;
    this.engine = new GraphEngine(this, cloneOptions(this.options), init.deps.cluster);
    this.controls = new GraphControls(this);
  }

  // -------------------------------------------------------------------- life

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const stage = this.stageEl;
    stage.addClass("fast-graph-stage");
    stage.style.padding = "0";
    stage.style.overflow = "hidden";
    stage.style.position = "relative";
    this.engine.attach();
    this.buildStatusLine();
    this.unsubscribe = this.init.deps.source.subscribe((next) => this.onRaw(next));
    this.engine.setClusterOptions(this.init.deps.cluster);
    this.engine.setOptions(cloneOptions(this.options));
    this.onRaw(this.init.deps.source.current());
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    if (this.saveTimer !== 0) window.clearTimeout(this.saveTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.hoverPopover = null;
    this.cardEl?.remove();
    this.cardEl = null;
    this.cardFolder = null;
    this.controls.destroy();
    this.engine.destroy();
    this.statusEl?.remove();
    this.statusEl = null;
    this.stageEl.empty();
    this.stageEl.removeClass("fast-graph-stage");
    this.stageEl.style.padding = "";
    this.stageEl.style.overflow = "";
    this.stageEl.style.position = "";
  }

  resize(): void {
    this.engine.resize();
  }

  cssChanged(): void {
    this.engine.onCssChange();
  }

  clusterChanged(): void {
    this.engine.setClusterOptions(this.init.deps.cluster);
    this.paintStatus();
  }

  focusSearch(): void {
    this.controls.focusSearch();
  }

  /** A leaf state carried `options`; push them in without echoing a save. */
  applyStateOptions(partial: Partial<GraphOptions>): void {
    assign(this.options, partial);
    if (!this.loaded) return;
    this.controls.applyOptions(this.options);
    this.engine.setClusterOptions(this.init.deps.cluster);
    this.engine.setOptions(cloneOptions(this.options));
  }

  /** PNG data url of what is on screen, or null while there is nothing to shoot. */
  screenshot(): string | null {
    return this.engine.screenshot();
  }

  private onRaw(raw: RawGraph): void {
    this.engine.setRaw(raw);
  }

  // ------------------------------------------------------------- host: panel

  get parentEl(): HTMLElement {
    return this.stageEl;
  }

  get isLocal(): boolean {
    return this.init.isLocal;
  }

  get app(): App {
    return this.init.deps.app;
  }

  onOptionsChange(): void {
    // native reads the panel back on every save, `close` included
    this.options.close = this.controls.collapsed;
    this.engine.setOptions(cloneOptions(this.options));
    if (this.saveTimer !== 0) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.init.onSave();
    }, 100);
  }

  startTimelapse(): void {
    if (!this.engine.startTimelapse()) this.setStatus("Timelapse is only for the global graph");
  }

  // --------------------------------------------------------------- host: input

  onNodeClick(node: HitNode, evt: MouseEvent): void {
    const app = this.app;
    if (node.kind === NodeKind.Cluster) {
      if (node.path !== null) this.engine.expandFolder(node.path);
      return;
    }
    if (node.kind === NodeKind.Tag) {
      this.openTagSearch(node.label);
      return;
    }
    void app.workspace.openLinkText(node.path ?? node.label, "", modEventPaneType(evt));
  }

  onNodeContext(node: HitNode, evt: MouseEvent): void {
    const app = this.app;
    if (node.kind === NodeKind.Cluster) {
      if (node.path !== null) this.engine.collapseFolder(node.path);
      return;
    }
    if (node.kind === NodeKind.Tag) {
      this.openTagSearch(node.label);
      return;
    }
    // unresolved links have nothing to show a menu for - the core plugin agrees
    const file = node.path === null ? null : this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) return;

    const menu = new Menu();
    addSections(menu, MENU_SECTIONS);
    setSectionSubmenu(menu, "view.linked", { title: "Open linked view", icon: "lucide-link" });
    const linktext = node.path ?? node.label;
    menu.addItem((item) => {
      item.setSection("title").setTitle(shortName(file)).setIsLabel(true);
      asTitleEl(item)?.addClass("u-muted", "u-small");
    });
    menu.addItem((item) => {
      item
        .setSection("open")
        .setTitle("Open in new tab")
        .setIcon("lucide-file-plus")
        .onClick(() => void app.workspace.openLinkText(linktext, "", modEventPaneType(evt) || true));
    });
    app.workspace.trigger("file-menu", menu, file, "graph-context-menu", this.init.leaf);
    menu.addItem((item) => {
      item
        .setSection("danger")
        .setTitle("Delete file")
        .setIcon("lucide-trash-2")
        .setWarning(true)
        .onClick(() => void app.fileManager.promptForDeletion(file));
    });
    menu.showAtMouseEvent(evt);
  }

  private openTagSearch(tag: string): void {
    const plugins = (this.app as unknown as {
      internalPlugins?: { getEnabledPluginById(id: string): unknown };
    }).internalPlugins;
    const search = plugins?.getEnabledPluginById("global-search") as
      | { openGlobalSearch(query: string): void }
      | undefined;
    search?.openGlobalSearch(`tag:${tag}`);
  }

  onNodeHover(node: HitNode | null, evt: MouseEvent | null): void {
    this.unhover();
    if (!node || !evt) return;
    // native previews files, the local root and attachments - never tags or unresolved links
    if (node.kind !== NodeKind.File && node.kind !== NodeKind.Attachment) return;
    const linktext = node.path ?? node.label;
    const popover = internalPopover(this.hoverPopover);
    if (popover && this.lastHoverLink === linktext && popover.state !== 0) {
      popover.onTarget = true;
      popover.transition();
      return;
    }
    this.lastHoverLink = linktext;
    this.app.workspace.trigger("hover-link", {
      event: evt,
      source: this.init.deps.hoverSource,
      hoverParent: this,
      targetEl: null,
      linktext,
    });
  }

  private unhover(): void {
    const popover = internalPopover(this.hoverPopover);
    if (!popover) return;
    popover.onTarget = false;
    popover.transition();
  }

  // ------------------------------------------------------------- host: chrome

  onClusterHover(meta: ClusterMeta | null, screen: { x: number; y: number } | null): void {
    if (!meta || !screen || !this.init.deps.cluster.showMetadata) {
      this.cardEl?.detach();
      this.cardFolder = null;
      return;
    }
    if (this.cardFolder !== meta.folder) {
      this.renderCard(meta);
      this.cardFolder = meta.folder;
    }
    const card = this.cardEl;
    if (!card) return;
    card.detach();
    card.style.left = `${Math.max(8, Math.min(this.stageEl.clientWidth - card.offsetWidth - 8, screen.x + 16))}px`;
    card.style.top = `${Math.max(8, Math.min(this.stageEl.clientHeight - card.offsetHeight - 8, screen.y + 16))}px`;
    this.stageEl.appendChild(card);
  }

  private renderCard(meta: ClusterMeta): void {
    const card = this.cardEl ?? this.stageEl.createDiv({ cls: "fast-graph-card" });
    this.cardEl = card;
    card.empty();
    card.createDiv({ cls: "fast-graph-card-title", text: meta.folder || "/" });
    card.createDiv({
      cls: "fast-graph-card-count",
      text: `${formatInt(meta.fileCount)} note${meta.fileCount === 1 ? "" : "s"} · ${REASON_TEXT[meta.reason]}`,
    });

    const rows = card.createDiv({ cls: "fast-graph-card-stats" });
    this.cardRow(rows, "Files", `${formatInt(meta.directFiles)} here, ${formatInt(meta.subtreeFiles)} below`);
    if (meta.childFolders > 0) this.cardRow(rows, "Subfolders", formatInt(meta.childFolders));
    this.cardRow(rows, "Links in", formatInt(meta.inWeight));
    this.cardRow(rows, "Links out", formatInt(meta.outWeight));
    if (meta.internalLinks > 0) this.cardRow(rows, "Internal", `${formatInt(meta.internalLinks)} not drawn`);
    if (meta.sizeBytes > 0) this.cardRow(rows, "Size", formatBytes(meta.sizeBytes));

    if (meta.topFiles.length > 0) {
      const list = card.createDiv({ cls: "fast-graph-card-list" });
      for (const top of meta.topFiles) {
        list.createDiv({ cls: "fast-graph-card-item", text: `${top.name} · ${formatInt(top.deg)}` });
      }
    }
    if (meta.topTags.length > 0) {
      const tags = card.createDiv({ cls: "fast-graph-card-tags" });
      for (const tag of meta.topTags) {
        tags.createSpan({ cls: "fast-graph-card-tag", text: `#${tag.tag} ${formatInt(tag.count)}` });
      }
    }
    card.createDiv({
      cls: "fast-graph-card-hint",
      text: meta.overflow
        ? `Click for ${formatInt(REVEAL_STEP)} more · right-click to fold up`
        : `Click to show ${formatInt(REVEAL_STEP)} · right-click to fold`,
    });
  }

  private cardRow(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv({ cls: "fast-graph-card-row" });
    row.createSpan({ cls: "fast-graph-card-label", text: label });
    row.createSpan({ cls: "fast-graph-card-value", text: value });
  }

  onStats(stats: EngineStats): void {
    this.stats = stats;
    this.paintStatus();
  }

  onStatus(status: string | null): void {
    this.transient = status;
    this.paintStatus();
  }

  private setStatus(text: string): void {
    this.transient = text;
    this.paintStatus();
  }

  private buildStatusLine(): void {
    if (!this.init.deps.cluster.showStats) return;
    this.statusEl = this.stageEl.createDiv({ cls: "fast-graph-status" });
    this.paintStatus();
  }

  private paintStatus(): void {
    const el = this.statusEl;
    if (!el) return;
    el.style.display = this.init.deps.cluster.showStats ? "" : "none";
    const stats = this.stats;
    const parts: string[] = [];
    if (stats) {
      parts.push(`${formatInt(stats.nodes)} nodes`);
      parts.push(`${formatInt(stats.edges)} links`);
      if (stats.clusters > 0) {
        parts.push(`${formatInt(stats.clusters)} folders, ${formatInt(stats.collapsedFiles)} notes folded`);
      }
      parts.push(`build ${stats.buildMs.toFixed(0)} ms`);
      parts.push(`draw ${stats.renderMs.toFixed(1)} ms`);
    }
    if (this.transient) parts.push(this.transient);
    el.setText(parts.join(" · "));
  }

  /** Native polls the zoom every 2 s; the engine stops itself, so this is the quieter version. */
  onViewSettled(zoom: number): void {
    if (this.options.scale === zoom) return;
    this.options.scale = zoom;
    this.init.onSave();
  }
}

// ------------------------------------------------------------------ the views

/** Global graph: one shared option object, no per-leaf state, exactly like the core plugin. */
export class FastGraphView extends ItemView {
  private readonly presenter: GraphPresenter;
  private opened = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: GraphViewDeps,
    /** the type this view is registered under: "graph" under takeover, our own otherwise */
    private readonly viewTypeId: string = GRAPH_VIEW_TYPE,
  ) {
    super(leaf);
    this.presenter = new GraphPresenter({
      contentEl: this.contentEl,
      leaf,
      isLocal: false,
      deps,
      options: deps.globalOptions,
      onSave: () => this.save(),
    });
  }

  getViewType(): string {
    return this.viewTypeId;
  }

  getDisplayText(): string {
    return "Graph view";
  }

  getIcon(): string {
    return "lucide-git-fork";
  }

  async onOpen(): Promise<void> {
    this.navigation = true;
    this.opened = true;
    this.presenter.load();
    this.registerEvent(this.app.workspace.on("css-change", () => this.presenter.cssChanged()));
    requestAnimationFrame(() => this.presenter.resize());
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.presenter.unload();
  }

  getState(): Record<string, unknown> {
    // the global graph stores nothing per leaf: everything lives in graph.json
    return {};
  }

  setState(): Promise<void> {
    return Promise.resolve();
  }

  onResize(): void {
    this.presenter.resize();
  }

  showSearch(): void {
    this.presenter.focusSearch();
  }

  /** The timelapse command lands here, as `graph:animate` lands on the core plugin's. */
  startTimelapse(): void {
    this.presenter.startTimelapse();
  }

  applyClusterOptions(): void {
    this.presenter.clusterChanged();
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    addScreenshotItem(menu, this.presenter);
  }

  private save(): void {
    if (this.opened) this.deps.saveGlobal(this.presenter.options);
  }
}

/** Local graph: bound to a file, per-leaf options ride in workspace.json. */
export class FastLocalGraphView extends FileView {
  allowNoFile = true;

  private readonly presenter: GraphPresenter;
  private renderedPath: string | null = null;
  private updateTimer = 0;
  private opened = false;

  constructor(
    leaf: WorkspaceLeaf,
    deps: GraphViewDeps,
    /** the type this view is registered under: "localgraph" under takeover, our own otherwise */
    private readonly viewTypeId: string = LOCAL_GRAPH_VIEW_TYPE,
  ) {
    super(leaf);
    this.presenter = new GraphPresenter({
      contentEl: this.contentEl,
      leaf,
      isLocal: true,
      deps,
      options: cloneOptions(deps.globalOptions),
      onSave: () => this.save(),
    });
  }

  getViewType(): string {
    return this.viewTypeId;
  }

  getDisplayText(): string {
    const file = this.file;
    if (file && this.isLeafBoundToFile) return `Graph of ${file.basename}`;
    return "Local graph";
  }

  getIcon(): string {
    return "lucide-git-fork";
  }

  canAcceptExtension(): boolean {
    return true;
  }

  get isLeafBoundToFile(): boolean {
    const leaf = this.leaf as WorkspaceLeaf & { pinned?: boolean; group?: string | null };
    return !!leaf.pinned || !!leaf.group;
  }

  async onOpen(): Promise<void> {
    this.navigation = false;
    this.opened = true;
    this.presenter.load();
    this.registerEvent(this.app.workspace.on("css-change", () => this.presenter.cssChanged()));
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.followFile(file)));
    this.registerEvent(this.leaf.on("pinned-change", () => this.syncGroup()));
    this.registerEvent(this.leaf.on("group-change", () => this.syncGroup()));
    this.requestUpdate();
    requestAnimationFrame(() => this.presenter.resize());
  }

  async onClose(): Promise<void> {
    this.opened = false;
    if (this.updateTimer !== 0) window.clearTimeout(this.updateTimer);
    this.presenter.unload();
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), options: this.presenter.options };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const st = { ...((state ?? {}) as Record<string, unknown>) };
    const options = st.options;
    if (options && typeof options === "object") this.presenter.applyStateOptions(options as Partial<GraphOptions>);
    // a pane restored without a file shows the note that is open now
    if (st.file === undefined && !("group" in st) && !this.isLeafBoundToFile) {
      st.file = this.app.workspace.getActiveFile()?.path ?? null;
    }
    await super.setState(st, result);
    this.requestUpdate();
  }

  onResize(): void {
    this.presenter.resize();
  }

  showSearch(): void {
    this.presenter.focusSearch();
  }

  applyClusterOptions(): void {
    this.presenter.clusterChanged();
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    addScreenshotItem(menu, this.presenter);
  }

  private followFile(file: TFile | null): void {
    if (this.isLeafBoundToFile) return;
    void this.switchFile(file);
  }

  private syncGroup(): void {
    if (!this.isLeafBoundToFile) {
      void this.switchFile(this.app.workspace.getActiveFile());
      return;
    }
    const shared = this.groupFile();
    if (shared !== null) void this.switchFile(shared);
  }

  /** The file the rest of this leaf's group is showing, if any. */
  private groupFile(): TFile | null {
    const group = (this.leaf as WorkspaceLeaf & { group?: string | null }).group;
    if (!group) return null;
    let found: TFile | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found !== null || leaf === this.leaf) return;
      if ((leaf as WorkspaceLeaf & { group?: string }).group !== group) return;
      const view = leaf.view;
      if (view instanceof FileView && view.file) found = view.file;
    });
    return found;
  }

  private async switchFile(file: TFile | null): Promise<void> {
    if (this.file === file) return;
    // FileView.loadFile does the TFile user bookkeeping; it is not in the public typings
    const load = (this as unknown as { loadFile?: (f: TFile | null) => unknown }).loadFile;
    if (load) await load.call(this, file);
    else this.file = file;
    (this.leaf as unknown as { updateTitle?: () => void }).updateTitle?.();
    this.requestUpdate();
  }

  private requestUpdate(): void {
    if (this.updateTimer !== 0) return;
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = 0;
      this.update();
    }, 10);
  }

  private update(): void {
    const path = this.file?.path ?? null;
    if (path === this.renderedPath) {
      if (this.opened) this.presenter.engine.invalidate();
      return;
    }
    this.renderedPath = path;
    this.presenter.engine.setScope(path);
  }

  private save(): void {
    if (this.opened) this.app.workspace.requestSaveLayout();
  }
}

// -------------------------------------------------------------------- helpers

/**
 * `Keymap.isModEvent` only accepts Obsidian's `UserEvent` wrapper and these
 * events come off plain DOM listeners, so the mapping lives here: middle click
 * or Mod opens a tab, Mod+Alt splits, Mod+Alt+Shift pops a window.
 */
export function modEventPaneType(evt: MouseEvent): PaneType | boolean {
  if (evt.button === 1) return "tab";
  if (!isModKey(evt)) return false;
  if (!evt.altKey) return "tab";
  return evt.shiftKey ? "window" : "split";
}

function isModKey(evt: MouseEvent): boolean {
  const platform = navigator.platform || "";
  if (/iPhone|iPad|iPod/.test(platform)) return evt.ctrlKey || evt.metaKey;
  return /Mac/.test(platform) ? evt.metaKey : evt.ctrlKey;
}

/** `Copy screenshot` in the pane menu, worded the way the core plugin words it. */
function addScreenshotItem(menu: Menu, presenter: GraphPresenter): void {
  menu.addItem((item) => {
    item
      .setSection("action")
      .setTitle("Copy screenshot")
      .setIcon("lucide-image")
      .onClick(() => {
        const dataUrl = presenter.screenshot();
        if (dataUrl) void copyPng(dataUrl);
      });
  });
}

async function copyPng(dataUrl: string): Promise<void> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const clipper = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!clipper) throw new Error("Clipboard images are not supported here");
    await navigator.clipboard.write([new clipper({ "image/png": blob })]);
    new Notice("Screenshot copied to the clipboard.");
  } catch (error) {
    new Notice(error instanceof Error ? error.toString() : String(error));
  }
}

/** `Menu.addSections` and `setSectionSubmenu` order the core plugin's menu; neither is typed. */
function addSections(menu: Menu, sections: string[]): void {
  (menu as unknown as { addSections?: (sections: string[]) => void }).addSections?.(sections);
}

function setSectionSubmenu(menu: Menu, section: string, info: { title: string; icon: string }): void {
  (menu as unknown as {
    setSectionSubmenu?: (section: string, info: { title: string; icon: string }) => void;
  }).setSectionSubmenu?.(section, info);
}

function asTitleEl(item: unknown): HTMLElement | null {
  const el = (item as { titleEl?: HTMLElement }).titleEl;
  return el ?? null;
}

/** The core plugin labels the menu with `getShortName()`, which disambiguates same-named notes. */
function shortName(file: TFile): string {
  const fn = (file as unknown as { getShortName?: () => string }).getShortName;
  return fn ? fn.call(file) : file.basename;
}

/** Page preview's popover: `state`, `onTarget` and `transition` are all internal. */
function internalPopover(popover: HoverPopover | null): {
  state: number;
  onTarget: boolean;
  transition: () => void;
} | null {
  if (!popover) return null;
  return (popover as unknown as { state?: number; onTarget?: boolean; transition?: () => void })
    .state === undefined
    ? null
    : (popover as unknown as { state: number; onTarget: boolean; transition: () => void });
}

function cloneOptions(options: GraphOptions): GraphOptions {
  return { ...options, colorGroups: options.colorGroups.map((g) => ({ query: g.query, color: { ...g.color } })) };
}

function assign(target: GraphOptions, partial: Partial<GraphOptions>): void {
  const to = target as unknown as Record<string, unknown>;
  const groups = partial.colorGroups;
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined && key !== "colorGroups") to[key] = value;
  }
  if (groups) {
    target.colorGroups = groups.map((g) => ({ query: g.query, color: { a: g.color.a ?? 1, rgb: g.color.rgb ?? 0 } }));
  }
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
