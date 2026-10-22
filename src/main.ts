/** Entry point: documented-API view registration, persistence, and settings. */

import {
  Menu,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  getLanguage,
  moment,
  type App,
  type TAbstractFile,
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
  cloneGraphOptions,
  mergeData,
  sanitizeClusterOptions,
  type ClusterOptions,
  type GraphOptions,
  type PluginData,
} from "./settings";
import { setLocale, t } from "./i18n";

export default class FastGraphPlugin extends Plugin {
  options: GraphOptions = cloneGraphOptions(DEFAULT_GRAPH_OPTIONS);
  settings: PluginData = mergeData(null);
  source!: VaultGraphSource;
  private deps!: GraphViewDeps;

  async onload(): Promise<void> {
    setLocale(appLanguage());
    this.settings = mergeData(await this.loadData());
    this.options = cloneGraphOptions(this.settings.graph);
    this.source = new VaultGraphSource(this.app, this);
    this.deps = this.buildDeps();

    this.registerView(GRAPH_VIEW_TYPE, (leaf) => new FastGraphView(leaf, this.deps));
    this.registerView(LOCAL_GRAPH_VIEW_TYPE, (leaf) => new FastLocalGraphView(leaf, this.deps));
    this.registerHoverLinkSource(GRAPH_VIEW_TYPE, {
      display: t("view.clusteredGraph"),
      defaultMod: true,
    });
    this.addRibbonIcon("lucide-git-fork", t("command.open"), (evt) => this.openGraph(evt));
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => this.onFileMenu(menu, file)),
    );
    this.addCommands();
    this.addSettingTab(new FastGraphSettings(this.app, this));
  }

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
        return GRAPH_VIEW_TYPE;
      },
      saveGlobal(options: GraphOptions): void {
        self.persistGraph(options);
      },
    };
  }

  private addCommands(): void {
    this.addCommand({
      id: "open",
      name: t("command.open"),
      callback: () => this.openGraph(null),
    });
    this.addCommand({
      id: "open-local",
      name: t("command.openLocal"),
      checkCallback: (check) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!check) this.openLocalGraph(file);
        return true;
      },
    });
    this.addCommand({
      id: "animate",
      name: t("command.animate"),
      checkCallback: (check) => {
        const view = this.app.workspace.getActiveViewOfType(FastGraphView);
        if (!view) return false;
        if (!check) view.startTimelapse();
        return true;
      },
    });
    this.addCommand({
      id: "stop-animate",
      name: t("command.stopAnimate"),
      checkCallback: (check) => {
        const view = this.app.workspace.getActiveViewOfType(FastGraphView);
        if (!view || !view.timelapsing) return false;
        if (!check) view.stopTimelapse();
        return true;
      },
    });
  }

  private openGraph(evt: MouseEvent | null): void {
    const leaf = this.app.workspace.getLeaf(evt ? modEventPaneType(evt) : false);
    void leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true, state: {} });
  }

  private openLocalGraph(file: TFile): void {
    const leaf = this.app.workspace.getLeaf("split");
    void leaf.setViewState({ type: LOCAL_GRAPH_VIEW_TYPE, active: true, state: { file: file.path } });
  }

  private onFileMenu(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    menu.addItem((item) => {
      item
        .setSection("open")
        .setTitle(t("command.openLocal"))
        .setIcon("lucide-git-fork")
        .onClick(() => this.openLocalGraph(file));
    });
  }

  private persistGraph(options: GraphOptions): void {
    this.settings.graph = cloneGraphOptions(options);
    void this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    this.settings.graph = cloneGraphOptions(this.options);
    this.settings.cluster = sanitizeClusterOptions(this.settings.cluster);
    await this.saveData(this.settings);
  }

  /** Push edited clustering settings into every pane that is already open. */
  applyClusterOptions(): void {
    for (const type of [GRAPH_VIEW_TYPE, LOCAL_GRAPH_VIEW_TYPE]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        if (view instanceof FastGraphView || view instanceof FastLocalGraphView) view.applyClusterOptions();
      }
    }
  }
}

// ------------------------------------------------------------------- settings

/** The `settings.<key>.name` / `settings.<key>.desc` pairs the tab draws. */
type SettingKey =
  | "fold"
  | "threshold"
  | "countNotes"
  | "nodeBudget"
  | "metadataLimit"
  | "maxLabelChars"
  | "showMetadata"
  | "showStats";

class FastGraphSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: FastGraphPlugin) {
    super(app, plugin);
  }

  private get cluster(): ClusterOptions {
    return this.plugin.settings.cluster;
  }

  /**
   * A row with its translated name and description, tagged with the catalogue key so the
   * harness can find it without matching text that changes with the app language.
   */
  private option(key: SettingKey, descVars?: Record<string, string | number>): Setting {
    const setting = new Setting(this.containerEl)
      .setName(t(`settings.${key}.name`))
      .setDesc(t(`settings.${key}.desc`, descVars));
    setting.settingEl.dataset.fgvOption = key;
    return setting;
  }

  display(): void {
    this.containerEl.empty();

    this.option("fold").addToggle((toggle) =>
      toggle.setValue(this.cluster.enabled).onChange(async (value) => {
        this.cluster.enabled = value;
        await this.plugin.saveSettings();
        this.plugin.applyClusterOptions();
      }),
    );

    this.option("threshold", { default: DEFAULT_CLUSTER_OPTIONS.threshold }).addSlider((slider) =>
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

    this.option("countNotes").addDropdown((dropdown) =>
      dropdown
        .addOption("direct", t("settings.mode.direct"))
        .addOption("recursive", t("settings.mode.recursive"))
        .setValue(this.cluster.mode)
        .onChange(async (value) => {
          this.cluster.mode = value as ClusterOptions["mode"];
          await this.plugin.saveSettings();
          this.plugin.applyClusterOptions();
        }),
    );

    this.numberSetting(
      "nodeBudget",
      { default: DEFAULT_CLUSTER_OPTIONS.maxVisibleNodes },
      () => this.cluster.maxVisibleNodes,
      (value) => {
        this.cluster.maxVisibleNodes = value;
      },
      50,
    );

    this.numberSetting(
      "metadataLimit",
      undefined,
      () => this.cluster.maxMetadataNodes,
      (value) => {
        this.cluster.maxMetadataNodes = value;
      },
      0,
    );

    this.option("maxLabelChars").addSlider((slider) =>
      slider
        .setLimits(0, 80, 2)
        .setValue(this.cluster.maxLabelChars)
        .setDynamicTooltip()
        .setInstant(true)
        .onChange(async (value) => {
          this.cluster.maxLabelChars = value;
          await this.plugin.saveSettings();
          this.plugin.applyClusterOptions();
        }),
    );

    this.option("showMetadata").addToggle((toggle) =>
      toggle.setValue(this.cluster.showMetadata).onChange(async (value) => {
        this.cluster.showMetadata = value;
        await this.plugin.saveSettings();
        this.plugin.applyClusterOptions();
      }),
    );

    this.option("showStats").addToggle((toggle) =>
      toggle.setValue(this.cluster.showStats).onChange(async (value) => {
        this.cluster.showStats = value;
        await this.plugin.saveSettings();
        this.plugin.applyClusterOptions();
      }),
    );
  }

  private numberSetting(
    key: SettingKey,
    descVars: Record<string, string | number> | undefined,
    read: () => number,
    write: (value: number) => void,
    min: number,
  ): void {
    this.option(key, descVars).addText((text) =>
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

/**
 * The language Obsidian itself is running in. `getLanguage()` only exists from
 * 1.8.7 and `manifest.json` still promises 1.7.0, so `moment.locale()` - which
 * the app keeps in step with the same setting - covers the older builds.
 */
function appLanguage(): string {
  const code = typeof getLanguage === "function" ? getLanguage() : moment?.locale?.();
  return code || "en";
}
