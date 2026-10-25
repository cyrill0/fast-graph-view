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
  ItemView,
  Menu,
  Notice,
  Platform,
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
import { applyNativeOptions, cloneGraphOptions, type ClusterOptions, type GraphOptions } from "../settings";
import { REVEAL_STEP, GraphEngine, type EngineHost, type EngineStats, type HitNode } from "./engine";
import { GraphControls, type ControlsHost } from "./controls";
import { formatFixed, formatInt, t, tp } from "../i18n";

export const GRAPH_VIEW_TYPE = "fast-graph-view";
export const LOCAL_GRAPH_VIEW_TYPE = "fast-localgraph";

/** Whatever `main.ts` can hand a pane: the shared snapshot and the persistence hooks. */
export interface GraphViewDeps {
  app: App;
  source: VaultGraphSource;
  /** the live global-graph options, shared by every global leaf */
  globalOptions: GraphOptions;
  cluster: ClusterOptions;
  /** page-preview source id registered by this plugin */
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

/** The clause under a folded folder's name saying why it is folded. */
function reasonText(reason: ClusterMeta["reason"]): string {
  return t(`card.reason.${reason}`);
}

export class GraphPresenter implements EngineHost, ControlsHost, HoverParent {
  readonly engine: GraphEngine;
  readonly controls: GraphControls;
  readonly options: GraphOptions;
  readonly stageEl: HTMLElement;
  hoverPopover: HoverPopover | null = null;

  private readonly init: PresenterInit;
  private unsubscribe: (() => void) | null = null;
  private stats: EngineStats | null = null;
  private transient: string | null = null;
  private statusEl: HTMLElement | null = null;
  private cardEl: HTMLElement | null = null;
  private cardFolder: string | null = null;
  private loadingEl: HTMLElement | null = null;
  private saveTimer = 0;
  private loaded = false;

  constructor(init: PresenterInit) {
    this.init = init;
    this.options = init.options;
    this.stageEl = init.contentEl;
    this.engine = new GraphEngine(this, cloneGraphOptions(this.options), init.deps.cluster);
    this.controls = new GraphControls(this);
  }

  // -------------------------------------------------------------------- life

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const stage = this.stageEl;
    stage.addClass("fast-graph-stage");
    this.engine.attach();
    this.buildStatusLine();
    this.loadingEl = stage.createDiv({ cls: "fast-graph-loading" });
    this.unsubscribe = this.init.deps.source.subscribe((next) => this.onRaw(next));
    this.engine.setClusterOptions(this.init.deps.cluster);
    this.engine.setOptions(cloneGraphOptions(this.options));
    void this.init.deps.source.currentAsync().then((raw) => {
      if (this.loaded && raw) this.onRaw(raw);
    });
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
    this.loadingEl?.remove();
    this.loadingEl = null;
    this.controls.destroy();
    this.engine.destroy();
    this.statusEl?.remove();
    this.statusEl = null;
    this.stageEl.empty();
    this.stageEl.removeClass("fast-graph-stage");
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
    applyNativeOptions(this.options, partial);
    if (!this.loaded) return;
    this.controls.applyOptions(this.options);
    this.engine.setClusterOptions(this.init.deps.cluster);
    this.engine.setOptions(cloneGraphOptions(this.options));
  }

  /** PNG data url of what is on screen, or null while there is nothing to shoot. */
  screenshot(): string | null {
    return this.engine.screenshot();
  }

  private onRaw(raw: RawGraph): void {
    this.loadingEl?.remove();
    this.loadingEl = null;
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
    this.engine.setOptions(cloneGraphOptions(this.options));
    if (this.saveTimer !== 0) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.init.onSave();
    }, 100);
  }

  startTimelapse(): void {
    if (!this.engine.startTimelapse()) this.setStatus(t("status.timelapseGlobalOnly"));
  }

  stopTimelapse(): void {
    this.engine.stopTimelapse();
  }

  get timelapsing(): boolean {
    return this.engine.timelapsing;
  }

  // --------------------------------------------------------------- host: input

  onNodeClick(node: HitNode, evt: MouseEvent): void {
    const app = this.app;
    if (node.kind === NodeKind.Cluster) {
      if (node.path !== null) this.engine.expandFolder(node.path);
      return;
    }
    if (node.kind === NodeKind.Tag) {
      this.filterTag(node.label);
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
      this.filterTag(node.label);
      return;
    }
    // unresolved links have nothing to show a menu for - the core plugin agrees
    const file = node.path === null ? null : this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) return;

    const menu = new Menu();
    const linktext = node.path ?? node.label;
    menu.addItem((item) => {
      item.setSection("title").setTitle(file.basename).setIsLabel(true);
    });
    menu.addItem((item) => {
      item
        .setSection("open")
        .setTitle(t("menu.openInNewTab"))
        .setIcon("lucide-file-plus")
        .onClick(() => void app.workspace.openLinkText(linktext, "", modEventPaneType(evt) || true));
    });
    app.workspace.trigger("file-menu", menu, file, "graph-context-menu", this.init.leaf);
    menu.addItem((item) => {
      item
        .setSection("danger")
        .setTitle(t("menu.deleteFile"))
        .setIcon("lucide-trash-2")
        .setWarning(true)
        .onClick(() => void app.fileManager.promptForDeletion(file));
    });
    menu.showAtMouseEvent(evt);
  }

  private filterTag(tag: string): void {
    this.options.search = `tag:${tag}`;
    this.controls.applyOptions(this.options);
    this.onOptionsChange();
  }

  onNodeHover(node: HitNode | null, evt: MouseEvent | null): void {
    if (!node || !evt) {
      this.hoverPopover = null;
      return;
    }
    // native previews files, the local root and attachments - never tags or unresolved links
    if (node.kind !== NodeKind.File && node.kind !== NodeKind.Attachment) return;
    const linktext = node.path ?? node.label;
    this.app.workspace.trigger("hover-link", {
      event: evt,
      source: this.init.deps.hoverSource,
      hoverParent: this,
      targetEl: this.stageEl,
      linktext,
    });
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
      text: `${tp("card.noteCount", meta.fileCount)} · ${reasonText(meta.reason)}`,
    });

    const rows = card.createDiv({ cls: "fast-graph-card-stats" });
    this.cardRow(
      rows,
      t("card.files.label"),
      t("card.files.value", { here: formatInt(meta.directFiles), below: formatInt(meta.subtreeFiles) }),
    );
    if (meta.childFolders > 0) this.cardRow(rows, t("card.subfolders"), formatInt(meta.childFolders));
    this.cardRow(rows, t("card.linksIn"), formatInt(meta.inWeight));
    this.cardRow(rows, t("card.linksOut"), formatInt(meta.outWeight));
    if (meta.internalLinks > 0) {
      this.cardRow(rows, t("card.internal.label"), tp("card.internal.value", meta.internalLinks));
    }
    if (meta.sizeBytes > 0) this.cardRow(rows, t("card.size"), formatBytes(meta.sizeBytes));

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
        ? t("card.hintOverflow", { count: formatInt(REVEAL_STEP) })
        : t("card.hint", { count: formatInt(REVEAL_STEP) }),
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

  /** The reveal changed: swap the panel's start control for its stop one. */
  onTimelapseChange(): void {
    if (!this.loaded) return;
    this.controls.refreshTimelapse();
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
      parts.push(tp("status.nodes", stats.nodes));
      parts.push(tp("status.links", stats.edges));
      if (stats.clusters > 0) {
        parts.push(`${tp("status.folders", stats.clusters)}, ${tp("status.folded", stats.collapsedFiles)}`);
      }
      parts.push(t("status.buildMs", { ms: formatFixed(stats.buildMs, 0) }));
      parts.push(t("status.drawMs", { ms: formatFixed(stats.renderMs, 1) }));
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

/** Global graph backed by the plugin's persisted option object. */
export class FastGraphView extends ItemView {
  private readonly presenter: GraphPresenter;
  private opened = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: GraphViewDeps,
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
    return GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("view.graph");
  }

  getIcon(): string {
    return "lucide-git-fork";
  }

  async onOpen(): Promise<void> {
    this.navigation = true;
    this.opened = true;
    this.presenter.load();
    this.registerEvent(this.app.workspace.on("css-change", () => this.presenter.cssChanged()));
    window.requestAnimationFrame(() => this.presenter.resize());
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.presenter.unload();
  }

  getState(): Record<string, unknown> {
    // Global options live in the plugin's data.json.
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

  /** And the stop command, which only exists while a reveal is running. */
  stopTimelapse(): void {
    this.presenter.stopTimelapse();
  }

  get timelapsing(): boolean {
    return this.presenter.timelapsing;
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

/** Local graph rooted on a saved file path, with per-leaf options. */
export class FastLocalGraphView extends ItemView {
  private readonly presenter: GraphPresenter;
  private rootFile: TFile | null = null;
  private opened = false;

  constructor(
    leaf: WorkspaceLeaf,
    deps: GraphViewDeps,
  ) {
    super(leaf);
    this.presenter = new GraphPresenter({
      contentEl: this.contentEl,
      leaf,
      isLocal: true,
      deps,
      options: cloneGraphOptions(deps.globalOptions),
      onSave: () => this.save(),
    });
  }

  getViewType(): string {
    return LOCAL_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    const file = this.rootFile;
    if (file) return t("view.graphOfFile", { name: file.basename });
    return t("view.localGraph");
  }

  getIcon(): string {
    return "lucide-git-fork";
  }

  async onOpen(): Promise<void> {
    this.navigation = false;
    this.opened = true;
    this.presenter.load();
    this.registerEvent(this.app.workspace.on("css-change", () => this.presenter.cssChanged()));
    this.presenter.engine.setScope(this.rootFile?.path ?? null);
    window.requestAnimationFrame(() => this.presenter.resize());
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.presenter.unload();
  }

  getState(): Record<string, unknown> {
    return { file: this.rootFile?.path ?? null, options: this.presenter.options };
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const st = (state ?? {}) as Record<string, unknown>;
    const options = st.options;
    if (options && typeof options === "object") this.presenter.applyStateOptions(options);
    const path = typeof st.file === "string" ? st.file : this.app.workspace.getActiveFile()?.path;
    const candidate = path ? this.app.vault.getAbstractFileByPath(path) : null;
    this.rootFile = candidate instanceof TFile ? candidate : null;
    if (this.opened) {
      this.presenter.engine.setScope(this.rootFile?.path ?? null);
    }
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
  if (Platform.isIosApp) return evt.ctrlKey || evt.metaKey;
  return Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
}

/** The pane menu's screenshot entry, in the section the core plugin puts it in. */
function addScreenshotItem(menu: Menu, presenter: GraphPresenter): void {
  menu.addItem((item) => {
    item
      .setSection("action")
      .setTitle(t("menu.copyScreenshot"))
      .setIcon("lucide-image")
      .onClick(() => {
        const dataUrl = presenter.screenshot();
        if (dataUrl) void copyPng(dataUrl);
      });
  });
}

async function copyPng(dataUrl: string): Promise<void> {
  try {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("Invalid PNG data URL");
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    const clipper = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!clipper) {
      new Notice(t("notice.clipboardUnsupported"));
      return;
    }
    await navigator.clipboard.write([new clipper({ "image/png": blob })]);
    new Notice(t("notice.screenshotCopied"));
  } catch (error) {
    new Notice(error instanceof Error ? error.toString() : String(error));
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatFixed(value, unit === 0 ? 0 : 1)} ${units[unit]}`;
}
