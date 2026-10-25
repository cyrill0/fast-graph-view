/** The live graph: model → simulation → pixels, plus every pointer interaction.
 *
 *  Everything that has to happen at 60 Hz lives here, and it is deliberately
 *  arranged so that no frame allocates: colour buffers, fade buffers and the
 *  render scene are sized once per rebuild and then only rewritten.
 *
 *  Cost is bounded by three independent decisions:
 *
 *  - a rebuild only happens when the *topology* changed; force, size and colour
 *    changes take effect without re-running the builder;
 *  - positions arrive from the worker in a recycled buffer that is copied and
 *    handed straight back, so physics never blocks the frame;
 *  - the loop stops itself after 60 idle frames, exactly like the native
 *    renderer, and wakes on input.
 */

import { buildGraph, emptyGraphModel, type BuildOptions, type ColorGroup } from "../graph/build";
import { Platform } from "obsidian";
import { NodeKind, type ClusterMeta, type GraphModel } from "../graph/types";
import type { RawGraph } from "../graph/raw";
import { modelRadii } from "../graph/sizing";
import { t } from "../i18n";
import type { ClusterOptions, GraphOptions } from "../settings";
import { COLLIDE_RADIUS, ALPHA_MIN, ALPHA_REHEAT, ALPHA_START, repelToCharge, sliderToEngine } from "../layout/forces";
import type { ForceConfig } from "../layout/forces";
import { SimulationDriver } from "../layout/simulation";
import { Camera } from "../render/camera";
import { GraphRenderer, type RenderScene, type RenderStyle } from "../render/renderer";
import { LabelLayer, textAlphaFor } from "../render/labels";
import { ThemeReader, type GraphColors, type Rgba } from "../render/theme";
import { graphPerformanceProfile } from "./performance";
import {
  MobileQualityController,
  initialMobileTier,
  readMobileCapabilities,
  type MobileQualityProfile,
} from "../mobile/performance";

/** How many members a folder click reveals at a time. */
export const REVEAL_STEP = 25;
/** Native `cZ`: alpha of nodes that are not the hovered node or its neighbours. */
const FADE_DIM = 0.2;
/** Native eases toward the target by 10 % of the gap each rendered frame. */
const FADE_EASE = 0.1;
/** Easing alone never reaches its target, so the idle loop would never stop without this. */
const FADE_SNAP = 1 / 255;
const IDLE_FRAMES_TO_STOP = 60;
const MOBILE_CLUSTER_THRESHOLD = 15;
/** Fields that read arrow and +/- keystrokes themselves, so the camera must leave them alone. */
const TEXTUAL_INPUTS = new Set([
  "color", "date", "datetime-local", "email", "file", "month", "number", "password", "range",
  "search", "tel", "text", "time", "url", "week",
]);

export interface EngineHost {
  /** root element the canvases live in */
  stageEl: HTMLElement;
  isLocal: boolean;
  /** node clicked: files and unresolved links open, tags search, folders drill down */
  onNodeClick(node: HitNode, evt: MouseEvent): void;
  onNodeContext(node: HitNode, evt: MouseEvent): void;
  onNodeHover(node: HitNode | null, evt: MouseEvent | null): void;
  onClusterHover(meta: ClusterMeta | null, screen: { x: number; y: number } | null): void;
  onStats(stats: EngineStats): void;
  onStatus(status: string | null): void;
  /** the reveal started or stopped, including when it ended by itself */
  onTimelapseChange(): void;
  /** ask the view to persist `scale` the way native does (2 s watcher) */
  onViewSettled(zoom: number): void;
}

export interface HitNode {
  index: number;
  kind: number;
  label: string;
  /** vault path for files, folder path for clusters, null for tags/unresolved */
  path: string | null;
  fileId: number;
  clusterId: number;
  group: number;
}

export interface EngineStats {
  nodes: number;
  edges: number;
  clusters: number;
  collapsedFiles: number;
  buildMs: number;
  renderMs: number;
  alpha: number;
  worker: boolean;
}

const EMPTY_F = new Float32Array(0);

export class GraphEngine {
  readonly camera = new Camera();
  model: GraphModel | null = null;
  private readonly mobile = Platform.isMobile;
  private readonly quality: MobileQualityController | null;

  private renderer: GraphRenderer | null = null;
  private labelLayer: LabelLayer | null = null;
  private theme: ThemeReader;
  private driver: SimulationDriver;
  private host: EngineHost;

  /** engine-owned copy of the worker's positions; `model.pos` is transferred away */
  private pos: Float32Array = EMPTY_F;
  private radii: Float32Array = EMPTY_F;
  private collide: Float32Array = EMPTY_F;
  private nodeColor: Float32Array = EMPTY_F;
  private edgeColor: Float32Array = EMPTY_F;
  private fade: Float32Array = EMPTY_F;
  private edgeFade: Float32Array = EMPTY_F;
  private adjacent: Uint8Array = new Uint8Array(0);
  private hiddenEdge: Uint8Array = new Uint8Array(0);
  private groupColors: Rgba[] = [];
  private groupColorSource: ColorGroup[] | null = null;

  private alpha = ALPHA_START;
  private hoverNode = -1;
  private dragNode = -1;
  private focusIndex = -1;
  private pointerX = 0;
  private pointerY = 0;
  private pointerActive = false;

  private revealOverrides = new Map<string, number>();
  private forcedCollapsed = new Set<string>();

  private raf = 0;
  private idleFrames = 0;
  private running = false;
  private needsPaint = true;
  private fadesSettled = true;
  private colorsDirty = true;
  private rebuildTimer: number | null = null;
  private lastBuildMs = 0;
  private lastRenderMs = 0;
  private destroyed = false;
  private interacting = false;
  private contextLost = false;
  private lastFrameStarted = 0;
  private lastHoverTestAt = 0;

  /** timelapse state */
  private progressionLimit: number | null = null;
  private progressionTimer: number | null = null;
  private progressionSpeed = 20;
  private progressionStartedAt = 0;

  private raw: RawGraph | null = null;
  private scopePath: string | null = null;
  private options: GraphOptions;
  private cluster: ClusterOptions;

  constructor(host: EngineHost, options: GraphOptions, cluster: ClusterOptions) {
    this.host = host;
    this.options = options;
    this.cluster = cluster;
    this.theme = new ThemeReader(host.stageEl);
    this.quality = this.mobile
      ? new MobileQualityController(initialMobileTier(readMobileCapabilities()), performance.now())
      : null;
    this.driver = new SimulationDriver({
      onFrame: (positions, info) => this.onSimFrame(positions, info),
      onFallback: (reason) => this.host.onStatus(t("status.physicsMainThread", { reason })),
    });
    this.applySimulationCadence();
  }

  get usingWorker(): boolean {
    return this.driver.usingWorker;
  }

  // ------------------------------------------------------------------ setup

  /** Create the GL + label canvases. Must run once the stage has a size. */
  attach(): void {
    const stage = this.host.stageEl;
    const gl = createEl("canvas");
    gl.className = "graph-canvas fast-graph-gl";
    stage.appendChild(gl);
    gl.addEventListener("webglcontextlost", this.onContextLost);
    gl.addEventListener("webglcontextrestored", this.onContextRestored);
    try {
      this.renderer = new GraphRenderer(gl, this.mobile);
    } catch (error) {
      gl.remove();
      this.host.onStatus(t("status.webglUnavailable", { error: error instanceof Error ? error.message : String(error) }));
      this.renderer = null;
      return;
    }
    this.labelLayer = new LabelLayer(stage);
    this.resize();
    this.bindInput(gl);
    this.driver.setPaused(document.hidden);
  }

  resize(): void {
    const rect = this.host.stageEl.getBoundingClientRect();
    const deviceDpr = window.devicePixelRatio || 1;
    const dpr = this.mobile ? Math.min(deviceDpr, this.quality!.current.dprCap) : deviceDpr;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.camera.resize(width, height, dpr);
    if (this.renderer) {
      this.renderer.resize(width, height, dpr);
      this.labelLayer?.resize(width, height, dpr);
    }
    this.wake();
  }

  private applySimulationCadence(): void {
    const profile = this.quality?.effective(this.interacting);
    if (profile) {
      this.driver.setCadence(profile.simulationHz, profile.publishHz);
      return;
    }
    const model = this.model;
    const desktop = graphPerformanceProfile(model?.nodeCount ?? 0, model?.edgeCount ?? 0);
    this.driver.setCadence(desktop.simulationHz, desktop.publishHz);
  }

  private applyQualityChange(): void {
    this.applySimulationCadence();
    this.resize();
    // Runtime topology reduction is intentionally the final fallback. Tier
    // hysteresis keeps this from oscillating while the user manipulates the view.
    this.scheduleRebuild(ALPHA_REHEAT);
  }

  private setInteracting(interacting: boolean): void {
    if (this.interacting === interacting) return;
    this.interacting = interacting;
    this.applySimulationCadence();
    this.needsPaint = true;
  }

  private onContextLost = (evt: Event): void => {
    evt.preventDefault();
    this.contextLost = true;
    this.renderer = null;
    this.driver.setPaused(true);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
  };

  private onContextRestored = (): void => {
    if (this.destroyed) return;
    const canvas = this.host.stageEl.querySelector<HTMLCanvasElement>("canvas.fast-graph-gl");
    if (!canvas) return;
    try {
      this.renderer = new GraphRenderer(canvas, this.mobile);
      this.contextLost = false;
      this.resize();
      this.driver.setPaused(document.hidden);
      this.needsPaint = true;
      this.wake();
    } catch (error) {
      this.host.onStatus(t("status.webglUnavailable", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  private onVisibilityChange = (): void => {
    const paused = document.hidden || this.contextLost;
    this.driver.setPaused(paused);
    if (paused) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.running = false;
      return;
    }
    this.applySimulationCadence();
    this.resize();
    this.wake();
  };

  private onViewportResize = (): void => {
    if (!document.hidden && !this.destroyed) this.resize();
  };

  setOptions(options: GraphOptions): void {
    const before = this.options;
    this.options = options;
    const structural =
      before.search !== options.search ||
      before.showTags !== options.showTags ||
      before.showAttachments !== options.showAttachments ||
      before.hideUnresolved !== options.hideUnresolved ||
      before.showOrphans !== options.showOrphans ||
      before.localJumps !== options.localJumps ||
      before.localBacklinks !== options.localBacklinks ||
      before.localForelinks !== options.localForelinks ||
      before.localInterlinks !== options.localInterlinks ||
      groupsChanged(before.colorGroups, options.colorGroups);
    if (structural) this.scheduleRebuild();
    else if (before.nodeSizeMultiplier !== options.nodeSizeMultiplier) this.resizesNodes();

    const forcesChanged =
      before.centerStrength !== options.centerStrength ||
      before.repelStrength !== options.repelStrength ||
      before.linkStrength !== options.linkStrength ||
      before.linkDistance !== options.linkDistance;
    // Native pushes {forces, alpha: .3, run} on a slider move, nothing otherwise.
    this.pushForceConfig(forcesChanged ? ALPHA_REHEAT : undefined);
    this.needsPaint = true;
    this.wake();
  }

  setClusterOptions(cluster: ClusterOptions): void {
    const before = this.cluster;
    this.cluster = cluster;
    if (
      before.enabled !== cluster.enabled ||
      before.threshold !== cluster.threshold ||
      before.mode !== cluster.mode ||
      before.maxVisibleNodes !== cluster.maxVisibleNodes ||
      before.maxMetadataNodes !== cluster.maxMetadataNodes
    ) {
      this.scheduleRebuild();
    }
    if (before.maxLabelChars !== cluster.maxLabelChars) {
      // labels only: nothing to rebuild, but the frame has to be redrawn now
      this.needsPaint = true;
      this.wake();
    }
  }

  setRaw(raw: RawGraph | null): void {
    this.raw = raw;
    if (raw) {
      this.scheduleRebuild(ALPHA_START);
      return;
    }
    this.stopTimelapse();
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.cancelTouchLongPress();
    this.revealOverrides.clear();
    this.forcedCollapsed.clear();
    this.applyModel(emptyGraphModel(), 0, 0);
    // Do not leave the previous vault graph visible after consent is revoked.
    if (this.renderer) this.paint();
  }

  /** The vault changed; rebuild quietly so the layout barely moves. */
  invalidate(): void {
    this.scheduleRebuild(ALPHA_REHEAT);
  }

  setScope(path: string | null): void {
    if (this.scopePath === path) return;
    this.scopePath = path;
    this.camera.resetPan();
    this.scheduleRebuild(ALPHA_START);
  }

  onCssChange(): void {
    this.theme.refresh();
    this.cachedFont = "";
    this.colorsDirty = true;
    this.needsPaint = true;
    this.wake();
  }

  // ---------------------------------------------------------------- rebuild

  private scheduleRebuild(alpha = ALPHA_REHEAT): void {
    this.alpha = Math.max(this.alpha, alpha);
    if (this.rebuildTimer !== null) return;
    // Coalesce the burst of events a note save or a rename produces.
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 60);
  }

  rebuild(): void {
    const raw = this.raw;
    if (!raw || !this.renderer) return;
    if (this.host.isLocal && !this.scopePath) {
      // an unattached local pane has no scope, and `scopePath: null` means the whole vault
      this.applyModel(emptyGraphModel(), 0, this.alpha);
      return;
    }
    const options: BuildOptions = {
      ...clusterKeys(this.cluster, this.mobile ? this.quality!.current : null),
      showTags: this.options.showTags,
      showAttachments: this.options.showAttachments,
      showUnresolved: !this.options.hideUnresolved,
      showOrphans: this.host.isLocal ? true : this.options.showOrphans,
      maxNonFileNodes: this.mobile
        ? Math.min(this.cluster.maxMetadataNodes, this.quality!.current.metadataBudget)
        : this.cluster.maxMetadataNodes,
      revealOverrides: this.revealOverrides,
      forcedCollapsed: this.forcedCollapsed,
      scopePath: this.scopePath,
      scopeDepth: Math.max(1, Math.round(this.options.localJumps)),
      scopeForelinks: this.options.localForelinks,
      scopeBacklinks: this.options.localBacklinks,
      scopeInterlinks: this.options.localInterlinks,
      progressionLimit: this.progressionLimit,
      filterText: this.options.search,
      colorGroups: this.options.colorGroups,
      carry: this.model ? { model: this.model, pos: this.pos } : null,
    };
    const built = buildGraph(raw, options);
    this.applyModel(built.model, built.ms, this.alpha);
  }

  private applyModel(model: GraphModel, buildMs: number, alpha: number): void {
    const previous = this.model;
    this.model = model;
    this.lastBuildMs = buildMs;
    this.alpha = alpha;
    const n = model.nodeCount;
    const m = model.edgeCount;
    if (this.pos.length < n * 2) this.pos = new Float32Array(n * 2);
    this.pos.set(model.pos.subarray(0, n * 2));
    this.radii = modelRadii(model, this.options.nodeSizeMultiplier);
    this.collide = new Float32Array(n);
    for (let i = 0; i < n; i++) this.collide[i] = Math.max(COLLIDE_RADIUS, this.radii[i]);
    this.nodeColor = new Float32Array(n * 4);
    this.edgeColor = new Float32Array(m * 4);
    this.fade = new Float32Array(n);
    this.edgeFade = new Float32Array(m);
    this.fade.fill(1);
    this.edgeFade.fill(1);
    this.adjacent = new Uint8Array(n);
    this.hiddenEdge = reciprocalMask(model);
    this.hoverNode = -1;
    this.dragNode = -1;
    this.focusIndex = this.findFocus(model);
    this.groupColorSource = null;
    this.fadesSettled = true;
    this.colorsDirty = true;

    this.applySimulationCadence();
    this.driver.update(model, this.collide, alpha);
    if (!previous) this.camera.resetPan();
    this.reportStats();
    this.needsPaint = true;
    this.wake();
  }

  /** Node sizes only: geometry and collision move, the layout does not. */
  private resizesNodes(): void {
    if (!this.model) return;
    this.radii = modelRadii(this.model, this.options.nodeSizeMultiplier);
    for (let i = 0; i < this.collide.length; i++) this.collide[i] = Math.max(COLLIDE_RADIUS, this.radii[i]);
    this.driver.setRadius(this.collide);
    this.needsPaint = true;
  }

  // ---------------------------------------------------------------- colours

  /** Group colours come straight from the panel's swatches - rebuild only on change. */
  private syncGroupColors(): void {
    const source = this.options.colorGroups;
    if (source === this.groupColorSource) return;
    this.groupColorSource = source;
    this.colorsDirty = true;
    this.groupColors = source.map((g: ColorGroup) => ({
      r: ((g.color.rgb >> 16) & 255) / 255,
      g: ((g.color.rgb >> 8) & 255) / 255,
      b: (g.color.rgb & 255) / 255,
      a: g.color.a,
    }));
  }

  private baseColorOf(i: number, c: GraphColors): Rgba {
    const model = this.model!;
    const group = model.group[i];
    if (group >= 0 && this.groupColors[group]) return this.groupColors[group];
    switch (model.kind[i]) {
      case NodeKind.Tag:
        return c.fillTag;
      case NodeKind.Unresolved:
        return c.fillUnresolved;
      case NodeKind.Attachment:
        return c.fillAttachment;
      case NodeKind.Cluster:
        return c.fill;
      default:
        return i === this.focusIndex ? c.fillFocused : c.fill;
    }
  }

  /** The local graph tints its root node with `--graph-node-focused`. */
  private findFocus(model: GraphModel): number {
    if (!this.host.isLocal || !this.scopePath) return -1;
    for (let i = 0; i < model.nodeCount; i++) {
      if (model.kind[i] === NodeKind.File && model.path[i] === this.scopePath) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ frame

  private onSimFrame(pos: Float32Array, info: { alpha: number; settled: boolean; ticks: number }): void {
    this.pos.set(pos.subarray(0, Math.min(this.pos.length, pos.length)));
    this.alpha = info.alpha;
    this.needsPaint = true;
    if (info.settled) this.reportStats();
    this.wake();
  }

  private wake(): void {
    this.idleFrames = 0;
    if (this.running || this.destroyed) return;
    this.running = true;
    this.lastFrameStarted = 0;
    this.raf = window.requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    if (this.destroyed) return;
    const frameStarted = performance.now();
    const frameInterval = this.lastFrameStarted > 0 ? frameStarted - this.lastFrameStarted : 0;
    this.lastFrameStarted = frameStarted;
    const moved = this.camera.tick();
    const fading = !this.fadesSettled && this.fadesEasing();
    const painting = this.needsPaint || moved || fading;
    if (painting) {
      this.paint();
      this.needsPaint = false;
      this.idleFrames = 0;
      if (this.pointerActive && !this.panning && this.dragNode < 0) this.retestHover();
      const sampledMs = Math.max(performance.now() - frameStarted, frameInterval);
      if (this.quality?.sample(sampledMs, performance.now())) {
        this.applyQualityChange();
      }
    } else {
      this.idleFrames++;
    }
    if (this.idleFrames > IDLE_FRAMES_TO_STOP && this.alpha <= ALPHA_MIN) {
      this.running = false;
      this.raf = 0;
      this.host.onViewSettled(this.camera.zoom);
      return;
    }
    this.raf = window.requestAnimationFrame(this.frame);
  };

  /** True while any node is still easing toward its fade target. */
  private fadesEasing(): boolean {
    const model = this.model;
    if (!model) return false;
    const highlight = this.dragNode >= 0 ? this.dragNode : this.hoverNode;
    let moving = false;
    for (let i = 0; i < model.nodeCount; i++) {
      const target = highlight < 0 || i === highlight || this.adjacent[i] === 1 ? 1 : FADE_DIM;
      const current = this.fade[i];
      if (Math.abs(target - current) <= FADE_SNAP) {
        this.fade[i] = target;
        continue;
      }
      const next = current + (target - current) * FADE_EASE;
      this.fade[i] = next;
      moving = true;
    }
    for (let e = 0; e < model.edgeCount; e++) {
      const incident = highlight < 0 || model.eu[e] === highlight || model.ev[e] === highlight;
      const target = incident ? 1 : FADE_DIM;
      const current = this.edgeFade[e];
      if (Math.abs(target - current) <= FADE_SNAP) {
        this.edgeFade[e] = target;
        continue;
      }
      const next = current + (target - current) * FADE_EASE;
      this.edgeFade[e] = next;
      moving = true;
    }
    this.colorsDirty = true;
    if (!moving) this.fadesSettled = true;
    return moving;
  }

  private paint(): void {
    const model = this.model;
    const renderer = this.renderer;
    if (!model || !renderer) return;
    const started = performance.now();
    const c = this.theme.colors;
    const camera = this.camera.state();
    const zoom = camera.zoom;
    const dpr = this.camera.dpr;
    const highlight = this.dragNode >= 0 ? this.dragNode : this.hoverNode;
    const quality = this.quality?.effective(this.interacting);
    const desktop = graphPerformanceProfile(model.nodeCount, model.edgeCount, this.interacting);
    this.syncGroupColors();

    if (this.colorsDirty) {
      this.colorsDirty = false;
      // node alpha: eased fade × the colour's own CSS alpha
      for (let i = 0; i < model.nodeCount; i++) {
        const o = i * 4;
        const base = this.baseColorOf(i, c);
        this.nodeColor[o] = base.r;
        this.nodeColor[o + 1] = base.g;
        this.nodeColor[o + 2] = base.b;
        this.nodeColor[o + 3] = this.fade[i] * base.a;
      }
      for (let e = 0; e < model.edgeCount; e++) {
        const o = e * 4;
        const incident = highlight >= 0 && (model.eu[e] === highlight || model.ev[e] === highlight);
        const base = incident ? c.lineHighlight : c.line;
        this.edgeColor[o] = base.r;
        this.edgeColor[o + 1] = base.g;
        this.edgeColor[o + 2] = base.b;
        this.edgeColor[o + 3] = this.hiddenEdge[e] === 1 ? 0 : this.edgeFade[e] * base.a;
      }
    }

    const scene: RenderScene = {
      nodeCount: model.nodeCount,
      edgeCount: model.edgeCount,
      pos: this.pos,
      radii: this.radii,
      nodeColor: this.nodeColor,
      edgeColor: this.edgeColor,
      eu: model.eu,
      ev: model.ev,
    };
    const style: RenderStyle = {
      // native keeps line width constant in screen pixels
      lineWidthPx: this.options.lineSizeMultiplier * dpr,
      ring:
        highlight >= 0
          ? {
              x: this.pos[highlight * 2],
              y: this.pos[highlight * 2 + 1],
              radius: this.radii[highlight] + 3,
              stroke: Math.max(1, 1 / Math.sqrt(zoom)),
              color: c.circle,
            }
          : null,
      arrows:
        this.options.showArrow && (quality?.arrows ?? desktop.arrows) && zoom > 0.3
          ? {
              color: { ...c.arrow, a: c.arrow.a * Math.min(1, Math.max(0, 2 * (zoom - 0.3))) },
              size: 2 * Math.sqrt(this.options.lineSizeMultiplier) * dpr,
            }
          : null,
    };
    renderer.render(scene, camera, style);

    const textAlpha = textAlphaFor(zoom, this.options.textFadeMultiplier);
    if (this.labelLayer) {
      this.labelLayer.render(
        {
          labels: model.label,
          pos: this.pos,
          radii: this.radii,
          fade: this.fade,
          nodeCount: model.nodeCount,
          textAlpha,
          color: this.theme.textCss,
          fontStack: this.fontStack(),
          hovered: highlight,
          maxLabels: quality?.maxLabels ?? desktop.maxLabels,
          maxChars: this.cluster.maxLabelChars,
        },
        this.camera,
      );
    }
    this.lastRenderMs = performance.now() - started;
  }

  private fontStack(): string {
    if (this.cachedFont) return this.cachedFont;
    const probe = getComputedStyle(this.host.stageEl).fontFamily;
    this.cachedFont = probe || "var(--font-interface), sans-serif";
    return this.cachedFont;
  }

  private cachedFont = "";

  // -------------------------------------------------------------- interaction

  private bindInput(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerOutside);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("pointerup", this.onPointerOutside);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("resize", this.onViewportResize);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private unbindInput(): void {
    const canvas = this.host.stageEl.querySelector<HTMLCanvasElement>("canvas.fast-graph-gl");
    if (canvas) {
      canvas.removeEventListener("wheel", this.onWheel);
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerUp);
      canvas.removeEventListener("pointercancel", this.onPointerOutside);
      canvas.removeEventListener("pointerleave", this.onPointerLeave);
      canvas.removeEventListener("contextmenu", this.onContextMenu);
    }
    window.removeEventListener("pointerup", this.onPointerOutside);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("resize", this.onViewportResize);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private onWheel = (evt: WheelEvent): void => {
    evt.preventDefault();
    const rect = this.host.stageEl.getBoundingClientRect();
    this.camera.wheel(evt.deltaY, evt.deltaMode, evt.clientX - rect.left, evt.clientY - rect.top);
    this.wake();
  };

  private panning = false;
  private lastPanX = 0;
  private lastPanY = 0;
  private dragMoved = 0;
  private readonly touchPoints = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; x: number; y: number } | null = null;
  private touchTapNode = -1;
  private touchStartX = 0;
  private touchStartY = 0;
  private touchMoved = false;
  private touchLongPressTimer: number | null = null;
  private touchLongPressed = false;

  private onPointerDown = (evt: PointerEvent): void => {
    this.lastEvt = evt;
    const rect = this.host.stageEl.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    const hit = this.hitTest(x, y);
    if (evt.pointerType === "touch") {
      this.beginTouch(evt, x, y, hit);
      return;
    }
    if (hit >= 0 && (evt.button === 0 || (evt.button === 2 && isMac()))) {
      this.dragNode = hit;
      this.dragMoved = 0;
      this.lastPanX = x;
      this.lastPanY = y;
      this.pos[hit * 2] = this.worldX(x);
      this.pos[hit * 2 + 1] = this.worldY(y);
      this.driver.pin(hit, this.worldX(x), this.worldY(y), ALPHA_REHEAT);
      this.markAdjacent(hit);
    } else if (evt.button === 0 || evt.button === 1) {
      this.panning = true;
      this.lastPanX = x;
      this.lastPanY = y;
      this.host.stageEl.classList.add("is-grabbing");
    }
    this.pointerX = x;
    this.pointerY = y;
    this.pointerActive = true;
    try {
      (evt.target as HTMLElement).setPointerCapture?.(evt.pointerId);
    } catch {
      // the pointer is already gone; panning still works without the capture
    }
    this.wake();
  };

  private onPointerMove = (evt: PointerEvent): void => {
    this.lastEvt = evt;
    const rect = this.host.stageEl.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    if (evt.pointerType === "touch" && this.touchPoints.has(evt.pointerId)) {
      this.touchPoints.set(evt.pointerId, { x, y });
      if (this.pinch) {
        this.movePinch();
        return;
      }
      if (this.panning) {
        if (Math.hypot(x - this.touchStartX, y - this.touchStartY) > 8) {
          this.touchMoved = true;
          this.cancelTouchLongPress();
          if (this.hoverNode >= 0) this.setHover(-1);
        }
        this.camera.trackPan(x - this.lastPanX, y - this.lastPanY, performance.now());
        this.lastPanX = x;
        this.lastPanY = y;
        this.pointerX = x;
        this.pointerY = y;
        this.wake();
        return;
      }
    }
    this.pointerX = x;
    this.pointerY = y;
    this.pointerActive = true;
    if (this.dragNode >= 0) {
      this.dragMoved += Math.abs(x - this.lastPanX) + Math.abs(y - this.lastPanY);
      this.lastPanX = x;
      this.lastPanY = y;
      this.driver.pin(this.dragNode, this.worldX(x), this.worldY(y));
      this.wake();
      return;
    }
    if (this.panning) {
      this.camera.trackPan(x - this.lastPanX, y - this.lastPanY, performance.now());
      this.lastPanX = x;
      this.lastPanY = y;
      this.wake();
      return;
    }
    this.retestHover(true);
  };

  private onPointerUp = (evt: PointerEvent): void => {
    if (evt.pointerType === "touch") {
      this.endTouch(evt, true);
      return;
    }
    this.endPointer(evt, true);
  };

  /**
   * Observed: with the pointer over the canvas, releasing outside it never reaches the
   * canvas listener, so `panning` stayed live and the next pointermove teleported the view.
   */
  private onPointerOutside = (evt: PointerEvent): void => {
    if (this.destroyed) return;
    if (evt.pointerType === "touch") {
      this.endTouch(evt, false);
      return;
    }
    if (!this.panning && this.dragNode < 0) return;
    this.endPointer(evt, false);
  };

  /** Touch drags pan the graph, taps open a node, and two fingers pinch to zoom. */
  private beginTouch(evt: PointerEvent, x: number, y: number, hit: number): void {
    this.setInteracting(true);
    this.touchPoints.set(evt.pointerId, { x, y });
    this.pointerX = x;
    this.pointerY = y;
    // Touch does not continuously hover. Avoid a full hit-test/fade/card pass
    // on every move; a cluster may still show its card once on pointer-down.
    this.pointerActive = false;
    try {
      (evt.target as HTMLElement).setPointerCapture?.(evt.pointerId);
    } catch {
      // Pointer capture is not available on every mobile WebView.
    }
    this.camera.stopGlide();
    if (this.touchPoints.size >= 2) {
      this.cancelTouchLongPress();
      if (this.hoverNode >= 0) this.setHover(-1);
      this.touchTapNode = -1;
      this.touchMoved = true;
      this.panning = true;
      this.host.stageEl.classList.add("is-grabbing");
      this.pinch = this.measurePinch();
      this.wake();
      return;
    }

    this.touchTapNode = hit;
    this.touchStartX = x;
    this.touchStartY = y;
    this.touchMoved = false;
    this.touchLongPressed = false;
    this.lastPanX = x;
    this.lastPanY = y;
    this.panning = true;
    this.host.stageEl.classList.add("is-grabbing");
    if (hit >= 0 && this.model?.kind[hit] === NodeKind.Cluster) this.setHover(hit);
    if (hit >= 0) {
      this.touchLongPressTimer = window.setTimeout(() => {
        this.touchLongPressTimer = null;
        if (this.touchMoved || this.touchPoints.size !== 1) return;
        const node = this.nodeAt(hit);
        if (!node) return;
        this.touchLongPressed = true;
        this.touchTapNode = -1;
        this.host.onNodeContext(node, evt);
      }, 550);
    }
    this.wake();
  }

  private endTouch(evt: PointerEvent, allowClick: boolean): void {
    if (!this.touchPoints.has(evt.pointerId)) return;
    this.cancelTouchLongPress();
    const wasPinching = this.pinch !== null;
    this.touchPoints.delete(evt.pointerId);

    if (wasPinching) {
      this.touchTapNode = -1;
      this.touchMoved = true;
      if (this.touchPoints.size >= 2) {
        this.pinch = this.measurePinch();
      } else {
        this.pinch = null;
        const remaining = this.touchPoints.values().next().value;
        if (remaining) {
          // Continue naturally as a one-finger pan when one side of the pinch lifts.
          this.lastPanX = remaining.x;
          this.lastPanY = remaining.y;
          this.touchStartX = remaining.x;
          this.touchStartY = remaining.y;
          this.panning = true;
        } else {
          this.panning = false;
          this.setInteracting(false);
          this.camera.stopGlide();
          this.host.stageEl.classList.remove("is-grabbing");
        }
      }
      this.wake();
      return;
    }

    const tapNode = this.touchTapNode;
    const tapped = allowClick && !this.touchMoved && !this.touchLongPressed && tapNode >= 0;
    this.touchTapNode = -1;
    this.panning = false;
    this.setInteracting(false);
    if (this.hoverNode >= 0) this.setHover(-1);
    this.host.stageEl.classList.remove("is-grabbing");
    this.camera.releasePan();
    this.pointerActive = false;
    if (tapped) {
      const node = this.nodeAt(tapNode);
      if (node) this.host.onNodeClick(node, evt);
    }
    this.wake();
  }

  private cancelTouchLongPress(): void {
    if (this.touchLongPressTimer === null) return;
    window.clearTimeout(this.touchLongPressTimer);
    this.touchLongPressTimer = null;
  }

  private measurePinch(): { distance: number; x: number; y: number } | null {
    const points = this.touchPoints.values();
    const first = points.next().value;
    const second = points.next().value;
    if (!first || !second) return null;
    return {
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
  }

  private movePinch(): void {
    const previous = this.pinch;
    const next = this.measurePinch();
    if (!previous || !next) return;
    this.camera.zoomAt(next.distance / previous.distance, next.x, next.y);
    this.camera.panBy(next.x - previous.x, next.y - previous.y);
    this.pinch = next;
    this.needsPaint = true;
    this.wake();
  }

  private endPointer(evt: PointerEvent, allowClick: boolean): void {
    const dragged = this.dragNode;
    if (dragged >= 0) {
      this.driver.unpin(dragged);
      this.dragNode = -1;
      this.markAdjacent(this.hoverNode);
      const contextPress = isMac() && evt.ctrlKey;
      const clickable = evt.button === 0 || evt.button === 1;
      if (allowClick && this.dragMoved <= 5 && clickable && !contextPress) {
        const node = this.nodeAt(dragged);
        if (node) this.host.onNodeClick(node, evt);
      }
    } else if (this.panning) {
      this.camera.releasePan();
    }
    this.panning = false;
    this.host.stageEl.classList.remove("is-grabbing");
    if (dragged < 0) this.retestHover(true);
    this.wake();
  };

  private onPointerLeave = (): void => {
    this.pointerActive = false;
    if (this.hoverNode >= 0) this.setHover(-1);
  };

  private onContextMenu = (evt: MouseEvent): void => {
    this.lastEvt = evt;
    const rect = this.host.stageEl.getBoundingClientRect();
    const hit = this.hitTest(evt.clientX - rect.left, evt.clientY - rect.top);
    if (hit < 0) return;
    evt.preventDefault();
    const node = this.nodeAt(hit);
    if (node) this.host.onNodeContext(node, evt);
  };

  private onKeyDown = (evt: KeyboardEvent): void => {
    if (!this.cameraKeys(document.activeElement)) return;
    if (evt.key === "Escape") {
      // only borrow it while there is a reveal to halt, otherwise it stays Obsidian's
      if (this.progressionTimer !== null) {
        evt.preventDefault();
        this.stopTimelapse();
      }
      return;
    }
    const step = evt.shiftKey ? 60 : 20;
    let handled = true;
    switch (evt.key) {
      case "ArrowLeft":
        this.camera.panBy(step, 0);
        break;
      case "ArrowRight":
        this.camera.panBy(-step, 0);
        break;
      case "ArrowUp":
        this.camera.panBy(0, step);
        break;
      case "ArrowDown":
        this.camera.panBy(0, -step);
        break;
      case "+":
      case "=":
        this.camera.zoomAtCenter(evt.shiftKey ? 1.1 : 1.03);
        break;
      case "-":
      case "_":
        this.camera.zoomAtCenter(evt.shiftKey ? 1 / 1.1 : 1 / 1.03);
        break;
      default:
        handled = false;
    }
    if (handled) {
      evt.preventDefault();
      this.wake();
    }
  };

  /** Keys belong to the camera unless a field that consumes them has focus, or focus is outside this view. */
  private cameraKeys(el: Element | null): boolean {
    if (el === null || el === document.body) return true;
    if (!(el.instanceOf(HTMLElement))) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return false;
    if (tag === "INPUT" && TEXTUAL_INPUTS.has((el as HTMLInputElement).type)) return false;
    return this.host.stageEl.contains(el);
  }

  private worldX(cssX: number): number {
    return this.camera.screenToWorldX(cssX);
  }

  private worldY(cssY: number): number {
    return this.camera.screenToWorldY(cssY);
  }

  /** Node index whose screen disc contains `cssX/cssY`, or -1. */
  hitTest(cssX: number, cssY: number): number {
    const model = this.model;
    if (!model) return -1;
    const zoom = this.camera.zoom;
    const scale = Math.sqrt(zoom);
    const panX = this.camera.panX;
    const panY = this.camera.panY;
    const pos = this.pos;
    const radii = this.radii;
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < model.nodeCount; i++) {
      const x = pos[i * 2] * zoom + panX;
      const y = pos[i * 2 + 1] * zoom + panY;
      const r = radii[i] * scale + (this.mobile ? 8 : 2);
      const dx = x - cssX;
      const dy = y - cssY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestDistance) {
        bestDistance = d2;
        best = i;
      }
    }
    return best;
  }

  nodeAt(index: number): HitNode | null {
    const model = this.model;
    if (!model || index < 0 || index >= model.nodeCount) return null;
    return {
      index,
      kind: model.kind[index],
      label: model.label[index],
      path: model.path[index],
      fileId: model.fileId[index],
      clusterId: model.clusterId[index],
      group: model.group[index],
    };
  }

  private retestHover(force = false): void {
    const model = this.model;
    if (!force && model) {
      const interval = graphPerformanceProfile(model.nodeCount, model.edgeCount, this.interacting).hoverIntervalMs;
      const now = performance.now();
      if (interval > 0 && now - this.lastHoverTestAt < interval) return;
      this.lastHoverTestAt = now;
    }
    const hit = this.pointerActive ? this.hitTest(this.pointerX, this.pointerY) : -1;
    if (hit === this.hoverNode) return;
    this.setHover(hit);
  }

  private setHover(hit: number): void {
    this.hoverNode = hit;
    this.markAdjacent(hit);
    const node = hit >= 0 ? this.nodeAt(hit) : null;
    this.host.onNodeHover(node, node ? this.lastEvt : null);
    if (node && node.kind === NodeKind.Cluster && this.cluster.showMetadata) {
      const meta = this.model!.clusters[node.clusterId];
      this.host.onClusterHover(
        meta,
        { x: this.camera.worldToScreenX(this.pos[hit * 2]), y: this.camera.worldToScreenY(this.pos[hit * 2 + 1]) },
      );
    } else {
      this.host.onClusterHover(null, null);
    }
    this.needsPaint = true;
    this.wake();
  }

  private lastEvt: MouseEvent | null = null;

  /** Neighbour mask for the hover fade, straight out of the CSR adjacency. */
  private markAdjacent(node: number): void {
    this.adjacent.fill(0);
    this.fadesSettled = false;
    this.colorsDirty = true;
    const model = this.model;
    if (!model || node < 0) return;
    for (let k = model.adjOff[node]; k < model.adjOff[node + 1]; k++) this.adjacent[model.adjNode[k]] = 1;
    this.adjacent[node] = 1;
  }

  // ----------------------------------------------------------------- folders

  /** Click a folder node: reveal the next `REVEAL_STEP` members. */
  expandFolder(folder: string): void {
    const next = (this.revealOverrides.get(folder) ?? 0) + REVEAL_STEP;
    this.revealOverrides.set(folder, next);
    this.forcedCollapsed.delete(folder);
    this.scheduleRebuild(ALPHA_REHEAT);
  }

  /** How many members are already shown, so the UI can say "expand 25 more". */
  revealedCount(folder: string): number {
    return this.revealOverrides.get(folder) ?? 0;
  }

  collapseFolder(folder: string): void {
    this.revealOverrides.delete(folder);
    this.forcedCollapsed.add(folder);
    this.scheduleRebuild(ALPHA_REHEAT);
  }

  /** Undo every hand-built folder, back to what the rules say. */
  resetExploration(): void {
    this.revealOverrides.clear();
    this.forcedCollapsed.clear();
    this.stopTimelapse();
    this.scheduleRebuild(ALPHA_START);
  }

  get explorationSize(): number {
    return this.revealOverrides.size + this.forcedCollapsed.size;
  }

  // ------------------------------------------------------------------- forces

  pushForceConfig(reheat?: number): void {
    const o = this.options;
    const config: Partial<ForceConfig> = {
      centerStrength: sliderToEngine(clamp01(o.centerStrength)),
      linkStrength: clamp01(o.linkStrength),
      linkDistance: Math.max(1, o.linkDistance),
      charge: repelToCharge(Math.max(0, o.repelStrength)),
    };
    this.driver.setConfig(config, reheat);
    if (reheat !== undefined) this.wake();
  }

  // ----------------------------------------------------------------- timelapse

  /** Native `renderProgression`: grow the visible set by link count over time. */
  startTimelapse(): boolean {
    if (this.host.isLocal || !this.raw) return false;
    if (this.progressionTimer !== null) {
      window.clearInterval(this.progressionTimer);
      this.progressionTimer = null;
    }
    const links = this.model ? this.model.edgeCount : this.raw.edgeCount;
    this.progressionSpeed = Math.min(100, Math.max(5, 0.5 * Math.sqrt(links)));
    this.progressionStartedAt = performance.now();
    this.progressionLimit = 0;
    this.rebuild();
    this.progressionTimer = window.setInterval(() => {
      const elapsed = (performance.now() - this.progressionStartedAt) / 1000;
      const next = Math.floor(this.progressionSpeed * elapsed);
      if (!this.raw || next >= this.raw.fileCount) {
        this.stopTimelapse();
        return;
      }
      this.progressionLimit = next;
      this.rebuild();
    }, 500);
    this.host.onStatus(t("status.timelapseRunning"));
    this.host.onTimelapseChange();
    return true;
  }

  stopTimelapse(): void {
    if (this.progressionTimer !== null) {
      window.clearInterval(this.progressionTimer);
      this.progressionTimer = null;
      this.progressionLimit = null;
      this.host.onStatus(null);
      this.host.onTimelapseChange();
      this.scheduleRebuild(ALPHA_REHEAT);
    }
  }

  get timelapsing(): boolean {
    return this.progressionTimer !== null;
  }

  // -------------------------------------------------------------------- misc

  /** PNG data url of exactly what is on screen, labels included. */
  screenshot(): string | null {
    const renderer = this.renderer;
    if (!renderer || !this.model || !this.raw) return null;
    this.paint();
    return renderer.snapshot(this.labelLayer ? this.labelLayer.canvas : null);
  }

  get zoom(): number {
    return this.camera.zoom;
  }

  get alphaValue(): number {
    return this.alpha;
  }

  private reportStats(): void {
    const model = this.model;
    if (!model) return;
    this.host.onStats({
      nodes: model.nodeCount,
      edges: model.edgeCount,
      clusters: model.stats.clusters,
      collapsedFiles: model.stats.collapsedFiles,
      buildMs: this.lastBuildMs,
      renderMs: this.lastRenderMs,
      alpha: this.alpha,
      worker: this.driver.usingWorker,
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    this.cancelTouchLongPress();
    this.stopTimelapse();
    this.unbindInput();
    this.driver.destroy();
    const canvas = this.host.stageEl.querySelector<HTMLCanvasElement>("canvas.fast-graph-gl");
    canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.renderer?.dispose();
    canvas?.remove();
    this.labelLayer?.canvas.remove();
    this.theme.destroy();
  }
}

/**
 * Reciprocal links are drawn once. Native hides the edge whose source sorts
 * before its target, so the arrow direction of a two-way pair is stable.
 */
function reciprocalMask(model: GraphModel): Uint8Array {
  const out = new Uint8Array(model.edgeCount);
  const n = model.nodeCount;
  const forward = new Set<number>();
  for (let e = 0; e < model.edgeCount; e++) forward.add(model.eu[e] * n + model.ev[e]);
  for (let e = 0; e < model.edgeCount; e++) {
    const a = model.eu[e];
    const b = model.ev[e];
    if (!forward.has(b * n + a)) continue;
    if (compareIds(identityOf(model, a), identityOf(model, b)) < 0) out[e] = 1;
  }
  return out;
}

/** Files compare by vault path, everything else by the text it was built from. */
function identityOf(model: GraphModel, i: number): string {
  return model.path[i] ?? model.label[i];
}

function compareIds(a: string, b: string): number {
  return a.localeCompare(b);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function isMac(): boolean {
  return Platform.isMacOS;
}

/** Clustering settings are builder inputs; the native option keys are not. */
function clusterKeys(cluster: ClusterOptions, mobile: MobileQualityProfile | null): Pick<
  BuildOptions,
  | "clusterEnabled"
  | "clusterThreshold"
  | "clusterMode"
  | "maxVisibleNodes"
  | "minTagUses"
> {
  return {
    // Mobile gets a predictable upper bound even when desktop clustering is off.
    clusterEnabled: mobile !== null || cluster.enabled,
    clusterThreshold: mobile ? Math.min(cluster.threshold, MOBILE_CLUSTER_THRESHOLD) : cluster.threshold,
    clusterMode: cluster.mode,
    maxVisibleNodes: mobile ? Math.min(cluster.maxVisibleNodes, mobile.nodeBudget) : cluster.maxVisibleNodes,
    minTagUses: 1,
  };
}

/** Colour groups change which nodes are drawn, so a swap is a rebuild. */
function groupsChanged(a: ColorGroup[], b: ColorGroup[]): boolean {
  if (a === b) return false;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].query !== b[i].query || a[i].color.rgb !== b[i].color.rgb) return true;
  }
  return false;
}
