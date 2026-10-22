/** The floating control panel, section for section.
 *
 *  Every class name, label, tooltip, range and step below is what the core
 *  built-in graph uses, so the panel can reuse Obsidian's graph styling while
 *  the plugin persists its own validated settings.
 *
 *  The labels come from this plugin's own catalogues, which follow Obsidian's
 *  language setting - not from the core plugin, whose strings are not public API.
 */

import {
  ColorComponent,
  Setting,
  TextComponent,
  setIcon,
  setTooltip,
  type ButtonComponent,
  type SearchComponent,
  type SliderComponent,
} from "obsidian";
import type { ColorGroup } from "../graph/build";
import { DEFAULT_GRAPH_OPTIONS, type GraphOptions } from "../settings";
import { t } from "../i18n";

/**
 * The panel's strings, read from the catalogue on access.
 *
 * Getters rather than values: this module is evaluated at import time, before
 * `src/main.ts` injects the app language, so a plain `t()` here would freeze the
 * whole panel in English. Key names match the `panel.*` catalogue keys exactly.
 */
const TEXT = {
  get filters(): string { return t("panel.filters"); },
  get groups(): string { return t("panel.groups"); },
  get display(): string { return t("panel.display"); },
  get forces(): string { return t("panel.forces"); },
  get searchFiles(): string { return t("panel.searchFiles"); },
  get clearSearch(): string { return t("panel.clearSearch"); },
  get depth(): string { return t("panel.depth"); },
  get depthDescription(): string { return t("panel.depthDescription"); },
  get incoming(): string { return t("panel.incoming"); },
  get incomingDescription(): string { return t("panel.incomingDescription"); },
  get outgoing(): string { return t("panel.outgoing"); },
  get outgoingDescription(): string { return t("panel.outgoingDescription"); },
  get neighbor(): string { return t("panel.neighbor"); },
  get neighborDescription(): string { return t("panel.neighborDescription"); },
  get tags(): string { return t("panel.tags"); },
  get tagsDescription(): string { return t("panel.tagsDescription"); },
  get attachments(): string { return t("panel.attachments"); },
  get attachmentsDescription(): string { return t("panel.attachmentsDescription"); },
  get existingOnly(): string { return t("panel.existingOnly"); },
  get existingOnlyDescription(): string { return t("panel.existingOnlyDescription"); },
  get orphans(): string { return t("panel.orphans"); },
  get orphansDescription(): string { return t("panel.orphansDescription"); },
  get arrows(): string { return t("panel.arrows"); },
  get arrowsDescription(): string { return t("panel.arrowsDescription"); },
  get textFade(): string { return t("panel.textFade"); },
  get nodeSize(): string { return t("panel.nodeSize"); },
  get linkThickness(): string { return t("panel.linkThickness"); },
  get centerForce(): string { return t("panel.centerForce"); },
  get repelForce(): string { return t("panel.repelForce"); },
  get linkForce(): string { return t("panel.linkForce"); },
  get linkDistance(): string { return t("panel.linkDistance"); },
  get enterQuery(): string { return t("panel.enterQuery"); },
  get deleteGroup(): string { return t("panel.deleteGroup"); },
  get newGroup(): string { return t("panel.newGroup"); },
  get swatchTooltip(): string { return t("panel.swatchTooltip"); },
  get animate(): string { return t("panel.animate"); },
  get stop(): string { return t("panel.stop"); },
  get close(): string { return t("panel.close"); },
  get openSettings(): string { return t("panel.openSettings"); },
  get startTimelapse(): string { return t("panel.startTimelapse"); },
  get stopTimelapse(): string { return t("panel.stopTimelapse"); },
  get restoreDefaults(): string { return t("panel.restoreDefaults"); },
};

/** What the reset button puts back: everything except zoom, panel state and collapse state. */
const RESET_KEYS: (keyof GraphOptions)[] = [
  "search",
  "showTags",
  "showAttachments",
  "hideUnresolved",
  "showOrphans",
  "localJumps",
  "localBacklinks",
  "localForelinks",
  "localInterlinks",
  "showArrow",
  "textFadeMultiplier",
  "nodeSizeMultiplier",
  "lineSizeMultiplier",
  "centerStrength",
  "repelStrength",
  "linkStrength",
  "linkDistance",
];

type OptionListener = (value?: unknown) => unknown;

interface GroupRow {
  el: HTMLElement;
  query: TextComponent;
  color: ColorComponent;
}

/** Everything the row drag needs from the section that owns the rows. */
interface GroupBoard {
  rows: GroupRow[];
  rowsEl: HTMLElement;
  /** `app.css` keys the drag gap off `.tree-item-children.is-grabbing` */
  grabEl: HTMLElement;
  read: () => ColorGroup[];
  render: (groups: ColorGroup[]) => void;
  commit: () => void;
}

export interface ControlsHost {
  /** positioned element the panel is appended to */
  parentEl: HTMLElement;
  isLocal: boolean;
  /** the live options object; controls mutate it in place */
  options: GraphOptions;
  /** options changed: hand them to the engine and schedule a save */
  onOptionsChange(): void;
  /** the timelapse start control was pressed */
  startTimelapse(): void;
  /** the timelapse stop control was pressed */
  stopTimelapse(): void;
  /** is the reveal running right now? Decides which of the two controls is live. */
  readonly timelapsing: boolean;
}

export class GraphControls {
  readonly el: HTMLElement;
  private readonly host: ControlsHost;
  private readonly listeners: Record<string, OptionListener> = {};
  private searchInput: HTMLElement | null = null;
  private filterSection: ControlSection | null = null;
  private timelapseButton: ButtonComponent | null = null;
  private searchTimer: number | null = null;
  private groupTimer: number | null = null;
  private activeDragCleanup: (() => void) | null = null;

  constructor(host: ControlsHost) {
    this.host = host;
    const options = host.options;
    const el = (this.el = host.parentEl.createDiv({ cls: "graph-controls" }));
    el.dataset.ignoreSwipe = "true";

    this.button(el, "mod-close", "lucide-x", TEXT.close, () => {
      el.addClass("is-close");
      host.onOptionsChange();
    });
    this.button(el, "mod-open", "lucide-settings", TEXT.openSettings, () => {
      el.removeClass("is-close");
      host.onOptionsChange();
    });
    if (!host.isLocal) {
      this.button(el, "mod-animate", "lucide-wand-2", TEXT.startTimelapse, () => this.toggleTimelapse());
      this.button(el, "mod-stop", "lucide-square", TEXT.stopTimelapse, () => this.toggleTimelapse());
    }
    this.button(el, "mod-reset", "lucide-rotate-ccw", TEXT.restoreDefaults, () => this.restoreDefaults());

    this.buildFilterSection(el, options);
    this.buildGroupSection(el, options);
    this.buildDisplaySection(el, options);
    this.buildForceSection(el, options);
    el.toggleClass("is-close", !!options.close);
  }

  private button(
    parent: HTMLElement,
    mod: string,
    icon: string,
    tooltip: string,
    onClick: () => void,
  ): void {
    const el = parent.createDiv({ cls: `clickable-icon graph-controls-button ${mod}` });
    setIcon(el, icon);
    setTooltip(el, tooltip);
    el.addEventListener("click", onClick);
  }

  /** One listener map holds boolean, number and array components together. */
  private optionMap<T>(): Record<string, (value?: T) => T> {
    return this.listeners as never;
  }

  // ------------------------------------------------------------------ filters

  private buildFilterSection(parent: HTMLElement, options: GraphOptions): void {
    const section = this.addSection(parent, "filter", TEXT.filters, options);
    const children = section.childrenEl;

    new Setting(children)
      .addSearch((component: SearchComponent) => {
        this.searchInput = component.inputEl;
        component
          .setPlaceholder(TEXT.searchFiles)
          .setValue(options.search)
          .onChange(() => this.debounceSearch(component.getValue()))
          .registerOptionListener(this.optionMap<string>(), "search");
        setTooltip(component.clearButtonEl, TEXT.clearSearch);
        component.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
          if (evt.isComposing || evt.key !== "Enter") return;
          this.commitSearch(component.getValue());
        });
        return component;
      })
      .settingEl.addClass("mod-search-setting");

    if (this.host.isLocal) {
      new Setting(children)
        .setName(TEXT.depth)
        .setTooltip(TEXT.depthDescription)
        .setClass("mod-local-jumps")
        .setClass("mod-slider")
        .addSlider((slider: SliderComponent) => {
          slider
            .setLimits(1, 5, 1)
            .setValue(options.localJumps)
            .setInstant(true)
            .registerOptionListener(this.optionMap<number>(), "localJumps")
            .onChange((value) => {
              options.localJumps = value;
              this.host.onOptionsChange();
            });
          return slider;
        });
      this.toggle(children, "localBacklinks", TEXT.incoming, TEXT.incomingDescription, options.localBacklinks);
      this.toggle(children, "localForelinks", TEXT.outgoing, TEXT.outgoingDescription, options.localForelinks);
      this.toggle(children, "localInterlinks", TEXT.neighbor, TEXT.neighborDescription, options.localInterlinks);
    }
    this.toggle(children, "showTags", TEXT.tags, TEXT.tagsDescription, options.showTags);
    this.toggle(children, "showAttachments", TEXT.attachments, TEXT.attachmentsDescription, options.showAttachments);
    this.toggle(children, "hideUnresolved", TEXT.existingOnly, TEXT.existingOnlyDescription, options.hideUnresolved);
    if (!this.host.isLocal) {
      this.toggle(children, "showOrphans", TEXT.orphans, TEXT.orphansDescription, options.showOrphans);
    }
    this.filterSection = section;
  }

  private toggle(
    parent: HTMLElement,
    key: keyof GraphOptions,
    name: string,
    description: string,
    value: boolean,
  ): void {
    const options = this.host.options;
    const setting = new Setting(parent)
      .setName(name)
      .setTooltip(description)
      .setClass("mod-toggle")
      .addToggle((component) => {
        component
          .setValue(value)
          .registerOptionListener(this.optionMap<boolean>(), key)
          .onChange((next) => {
            options[key] = next as never;
            this.host.onOptionsChange();
          });
        return component;
      });
    setting.settingEl.dataset.fgvOption = key;
  }

  /** Native debounces typing at 250 ms and commits immediately on Enter. */
  private debounceSearch(value: string): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      this.commitSearch(value);
    }, 250);
  }

  private commitSearch(value: string): void {
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.host.options.search === value) return;
    this.host.options.search = value;
    this.host.onOptionsChange();
  }

  // ------------------------------------------------------------------- groups

  private buildGroupSection(parent: HTMLElement, options: GraphOptions): void {
    const section = this.addSection(parent, "color-groups", TEXT.groups, options);
    const rowsEl = section.childrenEl.createDiv({ cls: "graph-color-groups-container" });
    const rows: GroupRow[] = [];

    const read = (): ColorGroup[] =>
      rows.map((row) => ({ query: row.query.getValue(), color: { a: 1, rgb: colorInt(row.color) } }));

    const commit = (): void => {
      this.host.options.colorGroups = read();
      this.host.onOptionsChange();
    };

    const addRow = (group: ColorGroup): void => {
      const el = rowsEl.createDiv({ cls: "graph-color-group" });
      const query = new TextComponent(el)
        .setPlaceholder(TEXT.enterQuery)
        .setValue(group.query)
        .onChange(() => {
          if (this.groupTimer !== null) window.clearTimeout(this.groupTimer);
          this.groupTimer = window.setTimeout(() => {
            this.groupTimer = null;
            commit();
          }, 250);
        });
      const color = new ColorComponent(el);
      setColorInt(color, group.color.rgb);
      color.onChange(() => commit());
      const swatch = swatchEl(el, color);
      setTooltip(swatch, TEXT.swatchTooltip);
      const row: GroupRow = { el, query, color };
      swatch.addEventListener("pointerdown", (evt) =>
        this.dragRow(evt, row, { rows, rowsEl, grabEl: section.childrenEl, read, render, commit }),
      );
      const remove = el.createDiv({ cls: "clickable-icon" });
      setIcon(remove, "lucide-x");
      setTooltip(remove, TEXT.deleteGroup);
      remove.addEventListener("click", () => {
        const at = rows.indexOf(row);
        if (at >= 0) rows.splice(at, 1);
        el.remove();
        commit();
      });
      rows.push(row);
    };

    const render = (groups: ColorGroup[]): void => {
      rows.length = 0;
      rowsEl.empty();
      for (const group of groups) addRow(group);
    };

    this.listeners.colorGroups = (value?: unknown) => {
      if (Array.isArray(value)) render(value as ColorGroup[]);
      return read();
    };
    render(options.colorGroups);

    section.childrenEl
      .createDiv({ cls: "graph-color-button-container" })
      .createEl("button", { text: TEXT.newGroup })
      .addEventListener("click", () => {
        const hsl = { h: (40 * rows.length) % 360, s: isDarkMode() ? 70 : 60, l: 60 };
        addRow({ query: "", color: { a: 1, rgb: hslToRgbInt(hsl) } });
        commit();
      });
  }

  /** 5 px threshold, a `drag-ghost` clone, then the rows are re-rendered in the new order. */
  private dragRow(evt: PointerEvent, row: GroupRow, board: GroupBoard): void {
    if (evt.button !== 0 || board.rows.indexOf(row) < 0) return;
    this.activeDragCleanup?.();
    const el = row.el;
    const rect = el.getBoundingClientRect();
    const grabX = evt.clientX - rect.x;
    const grabY = evt.clientY - rect.y;
    let startX = evt.clientX;
    let startY = evt.clientY;
    let ghost: HTMLElement | null = null;

    const dropIndex = (y: number): number => {
      for (let i = 0; i < board.rows.length; i++) {
        const r = board.rows[i].el.getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return board.rows.length;
    };

    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (ghost) {
        ghost.remove();
        document.body.removeClass("is-grabbing");
        board.grabEl.removeClass("is-grabbing");
      }
      this.activeDragCleanup = null;
    };

    const move = (e: PointerEvent): void => {
      e.preventDefault();
      if (!ghost) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (dx * dx + dy * dy < 25) return;
        const width = el.offsetWidth;
        board.rows.splice(board.rows.indexOf(row), 1);
        ghost = el.cloneNode(true) as HTMLElement;
        ghost.addClass("drag-ghost");
        ghost.style.width = `${width}px`;
        document.body.appendChild(ghost);
        document.body.addClass("is-grabbing");
        board.grabEl.addClass("is-grabbing");
      }
      el.detach();
      ghost.style.left = `${e.clientX - grabX}px`;
      ghost.style.top = `${e.clientY - grabY}px`;
      const drop = dropIndex(e.clientY);
      for (let i = 0; i < board.rows.length; i++) {
        board.rows[i].el.style.top = i < drop ? "0" : `${board.rows[i].el.offsetHeight}px`;
      }
    };

    const up = (e: PointerEvent): void => {
      const hadGhost = ghost !== null;
      cleanup();
      if (!hadGhost) return;
      const dropped = { query: row.query.getValue(), color: { a: 1, rgb: colorInt(row.color) } };
      const ordered = board.read();
      ordered.splice(Math.min(dropIndex(e.clientY), ordered.length), 0, dropped);
      board.render(ordered);
      board.commit();
    };

    const cancel = (): void => cleanup();

    this.activeDragCleanup = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  // ---------------------------------------------------------------- timelapse

  /** One press reveals from the first note, the next one halts it. */
  private toggleTimelapse(): void {
    if (this.host.timelapsing) this.host.stopTimelapse();
    else this.host.startTimelapse();
  }

  private timelapseLabel(): string {
    return this.host.timelapsing ? TEXT.stop : TEXT.animate;
  }

  /** Call when the reveal starts or ends: swaps the header icon and relabels the row button. */
  refreshTimelapse(): void {
    this.el.toggleClass("is-timelapsing", this.host.timelapsing);
    this.timelapseButton?.setButtonText(this.timelapseLabel());
  }

  // ------------------------------------------------------------------ display

  private buildDisplaySection(parent: HTMLElement, options: GraphOptions): void {
    const section = this.addSection(parent, "display", TEXT.display, options);
    const children = section.childrenEl;
    this.toggle(children, "showArrow", TEXT.arrows, TEXT.arrowsDescription, options.showArrow);
    this.slider(children, "textFadeMultiplier", TEXT.textFade, options.textFadeMultiplier, -3, 3, 0.1);
    this.slider(children, "nodeSizeMultiplier", TEXT.nodeSize, options.nodeSizeMultiplier, 0.1, 5, "any");
    this.slider(children, "lineSizeMultiplier", TEXT.linkThickness, options.lineSizeMultiplier, 0.1, 5, "any");
    if (!this.host.isLocal) {
      new Setting(children).addButton((component) => {
        this.timelapseButton = component;
        component.setButtonText(this.timelapseLabel()).onClick(() => this.toggleTimelapse());
        return component;
      });
    }
  }

  private slider(
    parent: HTMLElement,
    key: keyof GraphOptions,
    name: string,
    value: number,
    min: number,
    max: number,
    step: number | "any",
  ): void {
    const options = this.host.options;
    const setting = new Setting(parent)
      .setName(name)
      .setClass("mod-slider")
      .addSlider((slider: SliderComponent) => {
        slider
          .setLimits(min, max, step)
          .setValue(value)
          .setInstant(true)
          .registerOptionListener(this.optionMap<number>(), key)
          .onChange((next) => {
            options[key] = next as never;
            this.host.onOptionsChange();
          });
        return slider;
      });
    setting.settingEl.dataset.fgvOption = key;
  }

  // ------------------------------------------------------------------- forces

  private buildForceSection(parent: HTMLElement, options: GraphOptions): void {
    const section = this.addSection(parent, "forces", TEXT.forces, options);
    const children = section.childrenEl;
    this.slider(children, "centerStrength", TEXT.centerForce, options.centerStrength, 0, 1, "any");
    this.slider(children, "repelStrength", TEXT.repelForce, options.repelStrength, 0, 20, "any");
    this.slider(children, "linkStrength", TEXT.linkForce, options.linkStrength, 0, 1, "any");
    this.slider(children, "linkDistance", TEXT.linkDistance, options.linkDistance, 30, 500, 1);
  }

  // -------------------------------------------------------------- panel state

  private addSection(parent: HTMLElement, key: string, label: string, options: GraphOptions): ControlSection {
    return new ControlSection(parent, key, label, options, this.listeners, () => this.host.onOptionsChange());
  }

  /** Push values from `options` into the widgets; never notifies the host. */
  applyOptions(options: GraphOptions): void {
    const source = options as unknown as Record<string, unknown>;
    for (const key of Object.keys(this.listeners)) {
      const value = source[key];
      if (value === undefined) continue;
      this.listeners[key](value);
    }
    this.el.toggleClass("is-close", !!options.close);
  }

  get collapsed(): boolean {
    return this.el.hasClass("is-close");
  }

  setOpen(open: boolean): void {
    this.el.toggleClass("is-close", !open);
    this.host.onOptionsChange();
  }

  /** Ctrl+F: reveal the panel, open Filters, focus the search box. */
  focusSearch(): void {
    this.el.removeClass("is-close");
    this.filterSection?.setCollapsed(false);
    const input = this.searchInput;
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
    this.host.onOptionsChange();
  }

  /** Native resets filter, groups, display and forces - never zoom or panel state. */
  restoreDefaults(): void {
    const options = this.host.options as unknown as Record<string, unknown>;
    const defaults = DEFAULT_GRAPH_OPTIONS as unknown as Record<string, unknown>;
    for (const key of RESET_KEYS) options[key] = defaults[key];
    this.host.options.colorGroups = [];
    this.applyOptions(this.host.options);
    this.host.onOptionsChange();
  }

  destroy(): void {
    this.activeDragCleanup?.();
    for (const timer of [this.searchTimer, this.groupTimer]) {
      if (timer !== null) window.clearTimeout(timer);
    }
    this.el.remove();
  }
}

/**
 * `tree-item` collapsible section. Native animates the height; this swaps a class
 * because `app.css` ships no rule for collapsed children at all.
 */
class ControlSection {
  readonly el: HTMLElement;
  readonly childrenEl: HTMLElement;
  private readonly iconEl: HTMLElement;
  private readonly onToggle: () => void;
  private readonly options: GraphOptions;
  private readonly optionKey: string;
  private collapsed: boolean;

  constructor(
    parent: HTMLElement,
    key: string,
    label: string,
    options: GraphOptions,
    listeners: Record<string, OptionListener>,
    onToggle: () => void,
  ) {
    this.onToggle = onToggle;
    this.options = options;
    this.optionKey = `collapse-${key}`;
    this.el = parent.createDiv({ cls: `tree-item graph-control-section mod-${key}` });
    const self = this.el.createDiv({ cls: "tree-item-self is-clickable mod-collapsible" });
    this.iconEl = self.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(this.iconEl, "right-triangle");
    self.createDiv({ cls: "tree-item-inner" }).createEl("header", {
      cls: "graph-control-section-header",
      text: label,
    });
    this.childrenEl = this.el.createDiv({ cls: "tree-item-children" });

    this.collapsed = (options as unknown as Record<string, unknown>)[this.optionKey] !== false;
    this.paint();

    const toggleFromClick = (evt: MouseEvent): void => {
      if (evt.button !== 0 && evt.button !== 1) return;
      if (evt.button === 0 && evt.defaultPrevented) return;
      if (evt.target instanceof HTMLElement && evt.target.closest("input, button, .clickable-icon")) return;
      this.setCollapsed(!this.collapsed);
    };
    self.addEventListener("click", toggleFromClick);
    self.addEventListener("auxclick", toggleFromClick);

    listeners[this.optionKey] = (value?: unknown) => {
      if (typeof value === "boolean") {
        if (value !== this.collapsed) {
          this.collapsed = value;
          this.paint();
        }
        return value;
      }
      return this.collapsed;
    };
  }

  private paint(): void {
    this.el.toggleClass("is-collapsed", this.collapsed);
    this.iconEl.toggleClass("is-collapsed", this.collapsed);
    this.childrenEl.toggleClass("is-hidden", this.collapsed);
  }

  setCollapsed(collapsed: boolean): void {
    if (this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    (this.options as unknown as Record<string, unknown>)[this.optionKey] = collapsed;
    this.paint();
    this.onToggle();
  }
}

/** Find the public component's rendered color input without relying on private fields. */
function swatchEl(row: HTMLElement, _color: ColorComponent): HTMLElement {
  return row.querySelector<HTMLElement>("input[type='color']") ?? row;
}

function colorInt(color: ColorComponent): number {
  return parseInt(color.getValue().replace("#", ""), 16) || 0;
}

function setColorInt(color: ColorComponent, rgb: number): void {
  color.setValue(`#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`);
}

/** Native asks `app.customCss`, which is not public; the body class is the documented equivalent. */
function isDarkMode(): boolean {
  return document.body.classList.contains("theme-dark");
}

function hslToRgbInt(hsl: { h: number; s: number; l: number }): number {
  const s = hsl.s / 100;
  const l = hsl.l / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hsl.h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hsl.h < 60) [r, g, b] = [c, x, 0];
  else if (hsl.h < 120) [r, g, b] = [x, c, 0];
  else if (hsl.h < 180) [r, g, b] = [0, c, x];
  else if (hsl.h < 240) [r, g, b] = [0, x, c];
  else if (hsl.h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to255 = (v: number): number => Math.round((v + m) * 255);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}
