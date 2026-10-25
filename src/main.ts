/** Entry point: documented-API view registration, persistence, and settings. */

import {
  Menu,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  moment,
  type App,
  type SettingDefinitionItem,
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
    const deps = Object.defineProperties(
      { saveGlobal: (options: GraphOptions): void => this.persistGraph(options) },
      {
        app: { enumerable: true, get: () => this.app },
        source: { enumerable: true, get: () => this.source },
        globalOptions: { enumerable: true, get: () => this.options },
        cluster: { enumerable: true, get: () => this.settings.cluster },
        hoverSource: { enumerable: true, get: () => GRAPH_VIEW_TYPE },
      },
    );
    return deps as GraphViewDeps;
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

  // Obsidian 1.13+ uses these for settings search. Older versions continue to
  // render the compatible display() fallback below.
  getSettingDefinitions(): SettingDefinitionItem[] {
    const keys: SettingKey[] = [
      "fold", "threshold", "countNotes", "nodeBudget", "metadataLimit",
      "maxLabelChars", "showMetadata", "showStats",
    ];
    return keys.map((key) => ({
      name: t(`settings.${key}.name`),
      desc: t(`settings.${key}.desc`, this.descriptionVariables(key)),
      render: (setting) => this.renderSetting(setting, key),
    }));
  }

  private descriptionVariables(key: SettingKey): Record<string, string | number> | undefined {
    if (key === "threshold") return { default: DEFAULT_CLUSTER_OPTIONS.threshold };
    if (key === "nodeBudget") return { default: DEFAULT_CLUSTER_OPTIONS.maxVisibleNodes };
    return undefined;
  }

  private renderSetting(setting: Setting, key: SettingKey): void {
    setting
      .setName(t(`settings.${key}.name`))
      .setDesc(t(`settings.${key}.desc`, this.descriptionVariables(key)));
    setting.settingEl.dataset.fgvOption = key;

    switch (key) {
      case "fold":
        setting.addToggle((toggle) => toggle.setValue(this.cluster.enabled).onChange(async (value) => {
          this.cluster.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.applyClusterOptions();
        }));
        break;
      case "threshold":
        setting.addSlider((slider) => slider
          .setLimits(1, 200, 1)
          .setValue(this.cluster.threshold)
          .setInstant(true)
          .onChange(async (value) => {
            this.cluster.threshold = value;
            await this.plugin.saveSettings();
            this.plugin.applyClusterOptions();
          }));
        break;
      case "countNotes":
        setting.addDropdown((dropdown) => dropdown
          .addOption("direct", t("settings.mode.direct"))
          .addOption("recursive", t("settings.mode.recursive"))
          .setValue(this.cluster.mode)
          .onChange(async (value) => {
            this.cluster.mode = value as ClusterOptions["mode"];
            await this.plugin.saveSettings();
            this.plugin.applyClusterOptions();
          }));
        break;
      case "nodeBudget":
        this.numberSetting(setting, () => this.cluster.maxVisibleNodes, (value) => {
          this.cluster.maxVisibleNodes = value;
        }, 50);
        break;
      case "metadataLimit":
        this.numberSetting(setting, () => this.cluster.maxMetadataNodes, (value) => {
          this.cluster.maxMetadataNodes = value;
        }, 0);
        break;
      case "maxLabelChars":
        setting.addSlider((slider) => slider
          .setLimits(0, 80, 2)
          .setValue(this.cluster.maxLabelChars)
          .setInstant(true)
          .onChange(async (value) => {
            this.cluster.maxLabelChars = value;
            await this.plugin.saveSettings();
            this.plugin.applyClusterOptions();
          }));
        break;
      case "showMetadata":
        setting.addToggle((toggle) => toggle.setValue(this.cluster.showMetadata).onChange(async (value) => {
          this.cluster.showMetadata = value;
          await this.plugin.saveSettings();
          this.plugin.applyClusterOptions();
        }));
        break;
      case "showStats":
        setting.addToggle((toggle) => toggle.setValue(this.cluster.showStats).onChange(async (value) => {
          this.cluster.showStats = value;
          await this.plugin.saveSettings();
          this.plugin.applyClusterOptions();
        }));
        break;
    }
  }

  display(): void {
    this.containerEl.empty();

    const keys: SettingKey[] = [
      "fold", "threshold", "countNotes", "nodeBudget", "metadataLimit",
      "maxLabelChars", "showMetadata", "showStats",
    ];
    for (const key of keys) this.renderSetting(new Setting(this.containerEl), key);
  }

  private numberSetting(
    setting: Setting,
    read: () => number,
    write: (value: number) => void,
    min: number,
  ): void {
    setting.addText((text) =>
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

/** Obsidian keeps Moment's locale in sync with the language selected by the user. */
function appLanguage(): string {
  return moment?.locale?.() || "en";
}
