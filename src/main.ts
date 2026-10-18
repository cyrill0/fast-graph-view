/** Entry point: registration, persistence, settings.
 *
 *  The plugin can run in two modes, and the difference is only *which view type
 *  it owns*:
 *
 *  - **takeover** (default) swaps the creators behind the core plugin's own
 *    `graph` / `localgraph` types. Everything that opens those types - the ribbon
 *    button, `Mod+G`, "Open local graph" in the file menu, the page-preview
 *    source, the leaf states already in `workspace.json` - then lands here
 *    without a single duplicate surface, and `.obsidian/graph.json` stays the
 *    store the core plugin writes to.
 *  - **standalone** registers `fast-graph` / `fast-localgraph` next to the
 *    native views so both can be compared side by side.
 *
 *  `viewRegistry.registerView` throws on an existing type, so takeover has to
 *  unregister first. The native creators are kept and put back on teardown,
 *  which is why the swap is reversible without restarting Obsidian.
 */

import {
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  type App,
  type Command,
  type TAbstractFile,
  type ViewCreator,
} from "obsidian";
import { VaultGraphSource } from "./graph/source";
import {
  GRAPH_VIEW_TYPE,
  LOCAL_GRAPH_VIEW_TYPE,
  FastGraphView,
  FastLocalGraphView,
  modEventPaneType,
  type GraphViewDeps,
} from "./view/graph-view";
import {
  DEFAULT_CLUSTER_OPTIONS,
  DEFAULT_GRAPH_OPTIONS,
  applyNativeOptions,
  mergeData,
  type ClusterOptions,
  type GraphOptions,
  type PluginData,
} from "./settings";

export const STANDALONE_GRAPH_TYPE = "fast-graph";
export const STANDALONE_LOCAL_TYPE = "fast-localgraph";
const HOVER_SOURCE_STANDALONE = "fast-graph";
const EMPTY_VIEW_TYPE = "empty";

/** The core `graph` internal plugin, as far as we care about it. */
interface CoreGraphPlugin {
  enabled: boolean;
  instance: {
    options: Record<string, unknown>;
    saveOptions(): void;
  };
}

interface Registry {
  viewByType: Record<string, ViewCreator | undefined>;
  registerView(type: string, creator: ViewCreator): void;
  unregisterView(type: string): void;
}

/** A native view type we have taken over, with the creator to put back. */
interface Swap {
  type: string;
  previous: ViewCreator | null;
  standalone: boolean;
}

export default class FastGraphPlugin extends Plugin {
  options: GraphOptions = { ...DEFAULT_GRAPH_OPTIONS };
  settings: PluginData = mergeData(null);
  source!: VaultGraphSource;
  private deps!: GraphViewDeps;
  private globalType: string = STANDALONE_GRAPH_TYPE;
  private localType: string | null = STANDALONE_LOCAL_TYPE;
  private managed: Swap[] = [];
  private commands: Command[] = [];
  private ribbon: HTMLElement | null = null;
  private hoverSource: string | null = null;

  async onload(): Promise<void> {
    this.settings = mergeData(await this.loadData());
    this.options = { ...this.settings.graph };
    this.source = new VaultGraphSource(this.app, this);
    this.deps = this.buildDeps();
    if (this.settings.takeover) this.seedFromNative();

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source, leaf) => this.onFileMenu(menu, file, source, leaf)),
    );
    this.addSettingTab(new FastGraphSettings(this.app, this));
    this.applyRegistration();
  }

  onunload(): void {
    // put the core plugin's creators back; leaves that still run our views are
    // harmless and turn native on the next reload
    this.teardown();
  }

  // ------------------------------------------------------------- registration

  private buildDeps(): GraphViewDeps {
    const self = this;
    return {
      get app(): App {
        return self.app;
      },
      get source(): VaultGraphSource {
        return self.source;
      },
      get globalOptions(): GraphOptions {
        return self.options;
      },
      get cluster(): ClusterOptions {
        return self.settings.cluster;
      },
      get hoverSource(): string {
        return self.globalType === GRAPH_VIEW_TYPE ? GRAPH_VIEW_TYPE : HOVER_SOURCE_STANDALONE;
      },
      saveGlobal(options: GraphOptions): void {
        self.persistGraph(options);
      },
    };
  }

  /** `.obsidian/graph.json` is the store the core plugin owns; read it first. */
  seedFromNative(): void {
    const core = this.coreGraph();
    if (core) applyNativeOptions(this.options, core.instance.options);
  }

  private coreGraph(): CoreGraphPlugin | null {
    const plugins = (this.app as unknown as {
      internalPlugins?: { getPluginById(id: string): unknown };
    }).internalPlugins;
    const wrapper = plugins?.getPluginById?.("graph");
    return (wrapper as CoreGraphPlugin | undefined) ?? null;
  }

  private registry(): Registry | null {
    return (this.app as unknown as { viewRegistry?: Registry }).viewRegistry ?? null;
  }

  /** Re-register everything, e.g. after the takeover toggle changed. */
  reRegister(): void {
    this.applyRegistration();
  }

  private applyRegistration(): void {
    this.teardown();
    const takeover = this.settings.takeover && this.registry() !== null;
    this.globalType = takeover ? GRAPH_VIEW_TYPE : STANDALONE_GRAPH_TYPE;
    this.localType = takeover
      ? this.settings.clusterLocalGraphs
        ? LOCAL_GRAPH_VIEW_TYPE
        : null
      : STANDALONE_LOCAL_TYPE;

    this.registerType(this.globalType, takeover, (leaf) => new FastGraphView(leaf, this.deps));
    if (this.localType !== null) {
      this.registerType(this.localType, takeover, (leaf) => new FastLocalGraphView(leaf, this.deps));
    }
    this.addSurfaces(takeover);
  }

  private registerType(type: string, takeover: boolean, creator: ViewCreator): void {
    if (!takeover) {
      // our own types: the framework detaches their leaves when the plugin is disabled
      this.registerView(type, creator);
      this.managed.push({ type, previous: null, standalone: true });
      return;
    }
    const registry = this.registry();
    if (!registry) return;
    const previous = registry.viewByType[type] ?? null;
    try {
      registry.unregisterView(type);
    } catch {
      // nothing registered under that type yet
    }
    try {
      registry.registerView(type, creator);
      this.managed.push({ type, previous, standalone: false });
      void this.refreshLeaves(type);
    } catch (error) {
      if (previous) try { registry.registerView(type, previous); } catch { /* leave it to a reload */ }
      new Notice(`Fast graph could not take over "${type}": ${text(error)}`);
    }
  }

  /** Leaves already open hold the other plugin's view class, so re-create them. */
  private async refreshLeaves(type: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(type)) {
      const view = leaf.view;
      if (view instanceof FastGraphView || view instanceof FastLocalGraphView) continue;
      const state = leaf.getViewState();
      await leaf.setViewState({ type: EMPTY_VIEW_TYPE, active: false });
      await leaf.setViewState({ ...state, active: false });
    }
  }

  private addSurfaces(takeover: boolean): void {
    if (!takeover) {
      this.ribbon = this.addRibbonIcon("lucide-git-fork", "Open clustered graph", (evt) => this.openGraph(evt));
      this.addCommandRecorded({
        id: "open",
        name: "Open clustered graph",
        callback: () => this.openGraph(null),
      });
      if (this.localType !== null) {
        this.addCommandRecorded({
          id: "open-local",
          name: "Open clustered local graph",
          checkCallback: (check) => {
            const file = this.app.workspace.getActiveFile();
            if (!file) return false;
            if (!check) this.openLocalGraph(file);
            return true;
          },
        });
      }
      this.registerHoverLinkSource(HOVER_SOURCE_STANDALONE, { display: "Clustered graph view", defaultMod: true });
      this.hoverSource = HOVER_SOURCE_STANDALONE;
    }
    // the core "Start graph timelapse animation" only recognises its own view class
    this.addCommandRecorded({
      id: "animate",
      name: "Start graph timelapse animation",
      checkCallback: (check) => {
        const view = this.app.workspace.getActiveViewOfType(FastGraphView);
        if (!view) return false;
        if (!check) view.startTimelapse();
        return true;
      },
    });
  }

  private addCommandRecorded(command: Command): void {
    this.commands.push(this.addCommand(command));
  }

  private openGraph(evt: MouseEvent | null): void {
    const leaf = this.app.workspace.getLeaf(evt ? modEventPaneType(evt) : false);
    void leaf.setViewState({ type: this.globalType, active: true, state: {} });
  }

  private openLocalGraph(file: TFile, group?: WorkspaceLeaf): void {
    const type = this.localType;
    if (type === null) return;
    const leaf = this.app.workspace.getLeaf("split");
    void leaf.setViewState({ type, active: true, group, state: { file: file.path } });
  }

  private onFileMenu(menu: Menu, file: TAbstractFile | null, source: string, leaf?: WorkspaceLeaf): void {
    // under takeover the core plugin already adds "Open local graph", and that
    // now opens our type - a second entry would be noise
    if (this.globalType === GRAPH_VIEW_TYPE || this.localType === null) return;
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!source || source === "sidebar-context-menu") return;
    const target = file;
    menu.addItem((item) => {
      item
        .setSection("open")
        .setTitle("Open clustered local graph")
        .setIcon("lucide-git-fork")
        .onClick(() => this.openLocalGraph(target, leaf));
    });
  }

  private teardown(): void {
    const registry = this.registry();
    for (const entry of this.managed) {
      try {
        registry?.unregisterView(entry.type);
      } catch {
        // already gone
      }
      if (entry.previous) {
        try {
          registry?.registerView(entry.type, entry.previous);
        } catch {
          // the native creator refused to come back; a reload fixes it
        }
      }
    }
    this.managed = [];
    for (const command of this.commands) this.removeCommand(`${this.manifest.id}:${command.id}`);
    this.commands = [];
    this.ribbon?.remove();
    this.ribbon = null;
    if (this.hoverSource !== null) {
      // present at runtime, absent from the public typings
      (this as unknown as { unregisterHoverLinkSource?(id: string): void }).unregisterHoverLinkSource?.(
        this.hoverSource,
      );
      this.hoverSource = null;
    }
  }

  // -------------------------------------------------------------- persistence

  private persistGraph(options: GraphOptions): void {
    const core = this.settings.takeover ? this.coreGraph() : null;
    if (core) {
      // write through the core plugin so `.obsidian/graph.json` stays the one store
      core.instance.options = options as unknown as Record<string, unknown>;
      core.instance.saveOptions();
      return;
    }
    this.settings.graph = options;
    void this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    this.settings.graph = this.options;
    await this.saveData(this.settings);
  }

  /** Push edited clustering settings into every pane that is already open. */
  applyClusterOptions(): void {
    for (const type of [this.globalType, this.localType]) {
      if (type === null) continue;
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        if (view instanceof FastGraphView || view instanceof FastLocalGraphView) view.applyClusterOptions();
      }
    }
  }
}

// ------------------------------------------------------------------- settings

class FastGraphSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: FastGraphPlugin) {
    super(app, plugin);
  }

  private get cluster(): ClusterOptions {
    return this.plugin.settings.cluster;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Replace the built-in graph view")
      .setDesc(
        "Takes over the graph and local graph panes, their ribbon button, Mod+G and the file menu entry, and keeps saving to .obsidian/graph.json. Turn this off to run beside the built-in view instead.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.takeover).onChange(async (value) => {
          this.plugin.settings.takeover = value;
          if (value) this.plugin.seedFromNative();
          await this.plugin.saveSettings();
          this.plugin.reRegister();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Also replace the local graph")
      .setDesc("Local graph panes fold up large folders too.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.clusterLocalGraphs).onChange(async (value) => {
          this.plugin.settings.clusterLocalGraphs = value;
          await this.plugin.saveSettings();
          this.plugin.reRegister();
        }),
      )
      .setDisabled(!this.plugin.settings.takeover);

    new Setting(containerEl)
      .setName("Fold up large folders")
      .setDesc("Draw one metadata node for a folder instead of every note inside it.")
      .addToggle((toggle) =>
        toggle.setValue(this.cluster.enabled).onChange(async (value) => {
          this.cluster.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.applyClusterOptions();
        }),
      );

    new Setting(containerEl)
      .setName("Files per folder before folding")
      .setDesc("The brief's rule is 20: a folder with more than 20 notes becomes a single node.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 200, 1)
          .setValue(this.cluster.threshold)
          .setDynamicTooltip()
          .setInstant(true)
          .onChange(async (value) => {
            this.cluster.threshold = value;
            await this.plugin.saveSettings();
            this.plugin.applyClusterOptions();
          }),
      );

    new Setting(containerEl)
      .setName("Count notes")
      .setDesc("Whether a folder is judged on the notes in it alone, or including its subfolders.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("direct", "Directly inside the folder")
          .addOption("recursive", "Including subfolders")
          .setValue(this.cluster.mode)
          .onChange(async (value) => {
            this.cluster.mode = value as ClusterOptions["mode"];
            await this.plugin.saveSettings();
            this.plugin.applyClusterOptions();
          }),
      );

    this.numberSetting(
      containerEl,
      "Node budget",
      `Hard ceiling on drawn nodes (${DEFAULT_CLUSTER_OPTIONS.maxVisibleNodes} by default). Folders fold until it holds.`,
      () => this.cluster.maxVisibleNodes,
      (value) => {
        this.cluster.maxVisibleNodes = value;
      },
      50,
    );

    this.numberSetting(
      containerEl,
      "Tag and unresolved link limit",
      "Cap on the non-file nodes a graph may hold.",
      () => this.cluster.maxMetadataNodes,
      (value) => {
        this.cluster.maxMetadataNodes = value;
      },
      0,
    );

    new Setting(containerEl)
      .setName("Show folder details on hover")
      .setDesc("Card with the note count, link weight and busiest notes of a folded folder.")
      .addToggle((toggle) =>
        toggle.setValue(this.cluster.showMetadata).onChange(async (value) => {
          this.cluster.showMetadata = value;
          await this.plugin.saveSettings();
          this.plugin.applyClusterOptions();
        }),
      );

    new Setting(containerEl)
      .setName("Show node and frame counts")
      .setDesc("The line in the corner of the pane with nodes, links, build and draw time.")
      .addToggle((toggle) =>
        toggle.setValue(this.cluster.showStats).onChange(async (value) => {
          this.cluster.showStats = value;
          await this.plugin.saveSettings();
          this.plugin.applyClusterOptions();
        }),
      );
  }

  private numberSetting(
    parent: HTMLElement,
    name: string,
    desc: string,
    read: () => number,
    write: (value: number) => void,
    min: number,
  ): void {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text
          .setPlaceholder(String(read()))
          .setValue(String(read()))
          .onChange(async (value) => {
            const parsed = Math.round(Number(value));
            if (!Number.isFinite(parsed) || parsed < min) return;
            write(parsed);
            await this.plugin.saveSettings();
            this.plugin.applyClusterOptions();
          }),
      );
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
