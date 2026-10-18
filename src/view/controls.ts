/** The floating control panel, section for section.
 *
 *  Every class name, label, tooltip, range and step below is what the core
 *  `graph` plugin builds, so the panel is styled by the rules already in
 *  `app.css` and the persisted keys stay interchangeable with `.obsidian/graph.json`.
 *
 *  Strings are hardcoded because `app.plugins.graphView` is not public API.
 */

import {
  ColorComponent,
  Setting,
  TextComponent,
  setIcon,
  setTooltip,
  type SearchComponent,
  type SliderComponent,
} from "obsidian";
import type { ColorGroup } from "../graph/build";
import { DEFAULT_GRAPH_OPTIONS, type GraphOptions } from "../settings";

const TEXT = {
  filters: "Filters",
  groups: "Groups",
  display: "Display",
  forces: "Forces",
  searchFiles: "Search files...",
  clearSearch: "Clear search",
  depth: "Depth",
  depthDescription: "Show nodes this number of links away",
  incoming: "Incoming links",
  incomingDescription: "Show links from other files",
  outgoing: "Outgoing links",
  outgoingDescription: "Show links to other files",
  neighbor: "Neighbor links",
  neighborDescription: "Show links between neighbors",
  tags: "Tags",
  tagsDescription: "Tags are linked to the files that contain them",
  attachments: "Attachments",
  attachmentsDescription: "Show attachments",
  existingOnly: "Existing files only",
  existingOnlyDescription: "When enabled, links to nonexistent files are not shown",
  orphans: "Orphans",
  orphansDescription: "Show files that are not linked to any other file",
  arrows: "Arrows",
  arrowsDescription: "Show arrows when zoomed in",
  textFade: "Text fade threshold",
  nodeSize: "Node size",
  linkThickness: "Link thickness",
  centerForce: "Center force",
  repelForce: "Repel force",
  linkForce: "Link force",
  linkDistance: "Link distance",
  enterQuery: "Enter query...",
  deleteGroup: "Delete group",
  newGroup: "New group",
  swatchTooltip: "Click to change color\nDrag to reorder groups",
  animate: "Animate",
  close: "Close",
  openSettings: "Open graph settings",
  startTimelapse: "Start timelapse animation",
  restoreDefaults: "Restore default settings",
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
  /** the timelapse button was pressed */
  startTimelapse(): void;
}

export class GraphControls {
  readonly el: HTMLElement;
  private readonly host: ControlsHost;
  private readonly listeners: Record<string, OptionListener> = {};
  private searchInput: HTMLElement | null = null;
  private filterSection: ControlSection | null = null;
  private searchTimer: number | null = null;
  private groupTimer: number | null = null;

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
      this.button(el, "mod-animate", "lucide-wand-2", TEXT.startTimelapse, () => host.startTimelapse());
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
    new Setting(parent)
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
      swatch.addEventListener("mousedown", (evt) =>
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
  private dragRow(evt: MouseEvent, row: GroupRow, board: GroupBoard): void {
    if (evt.button !== 0 || board.rows.indexOf(row) < 0) return;
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

    const move = (e: MouseEvent): void => {
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

    const up = (e: MouseEvent): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!ghost) return;
      ghost.remove();
      document.body.removeClass("is-grabbing");
      board.grabEl.removeClass("is-grabbing");
      const dropped = { query: row.query.getValue(), color: { a: 1, rgb: colorInt(row.color) } };
      const ordered = board.read();
      ordered.splice(Math.min(dropIndex(e.clientY), ordered.length), 0, dropped);
      board.render(ordered);
      board.commit();
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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
        component.setButtonText(TEXT.animate).onClick(() => this.host.startTimelapse());
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
    new Setting(parent)
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
    this.el = parent.createDiv({ cls: `tree-item graph-control-section mod-${key}` });
    const self = this.el.createDiv({ cls: "tree-item-self is-clickable mod-collapsible" });
    this.iconEl = self.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(this.iconEl, "right-triangle");
    self.createDiv({ cls: "tree-item-inner" }).createEl("header", {
      cls: "graph-control-section-header",
      text: label,
    });
    this.childrenEl = this.el.createDiv({ cls: "tree-item-children" });

    this.collapsed = options[`collapse-${key}` as keyof GraphOptions] !== false;
    this.paint();

    const toggleFromClick = (evt: MouseEvent): void => {
      if (evt.button !== 0 && evt.button !== 1) return;
      if (evt.button === 0 && evt.defaultPrevented) return;
      if (evt.target instanceof HTMLElement && evt.target.closest("input, button, .clickable-icon")) return;
      this.setCollapsed(!this.collapsed);
    };
    self.addEventListener("click", toggleFromClick);
    self.addEventListener("auxclick", toggleFromClick);

    listeners[`collapse-${key}`] = (value?: unknown) => {
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
    this.paint();
    this.onToggle();
  }
}

interface ColorComponentInternals {
  colorPickerEl?: HTMLElement;
  getValueInt?(): number;
  setValueInt?(value: number): unknown;
}

function internals(color: ColorComponent): ColorComponentInternals {
  return color as unknown as ColorComponentInternals;
}

/** The swatch is the native `input[type=color]`, with `colorPickerEl` preferred. */
function swatchEl(row: HTMLElement, color: ColorComponent): HTMLElement {
  return internals(color).colorPickerEl ?? row.querySelector<HTMLElement>("input[type='color']") ?? row;
}

function colorInt(color: ColorComponent): number {
  const read = internals(color).getValueInt;
  if (read) return read.call(color);
  return parseInt(color.getValue().replace("#", ""), 16) || 0;
}

function setColorInt(color: ColorComponent, rgb: number): void {
  const write = internals(color).setValueInt;
  if (write) {
    write.call(color, rgb);
    return;
  }
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
