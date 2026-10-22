/** Main-thread half of the simulation.
 *
 *  The physics runs in a blob worker built from `sim-worker.ts`; when workers
 *  are unavailable (older mobile WebViews, a strict CSP) the same
 *  `SimulationCore` is driven on the main thread in a rAF loop instead, so the
 *  layout laws stay identical on both paths.
 */

import { WORKER_SOURCE } from "../generated/worker-source";
import type { GraphModel } from "../graph/types";
import { SimulationCore } from "./forces";
import { ALPHA_MIN, ALPHA_REHEAT, ALPHA_START, DEFAULT_FORCE_CONFIG } from "./forces";
import type { ForceConfig } from "./forces";
import type { InitMessage, PublishMessage } from "./sim-worker";

export interface FrameInfo {
  alpha: number;
  settled: boolean;
  ticks: number;
}

export interface DriverOptions {
  onFrame: (pos: Float32Array, info: FrameInfo) => void;
  /** called once if the worker could not be created, so the UI can say so */
  onFallback?: (reason: string) => void;
}

export class SimulationDriver {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private inline: SimulationCore | null = null;
  private inlineTimer: number | null = null;
  private revision = -1;
  private config: ForceConfig = { ...DEFAULT_FORCE_CONFIG };
  private options: DriverOptions;
  private pendingInit: InitMessage | null = null;
  private lastInit: InitMessage | null = null;
  private simulationHz = 60;
  private publishHz = 60;
  private inlinePublishAccumulator = 0;
  private paused = false;
  private destroyed = false;

  constructor(options: DriverOptions) {
    this.options = options;
    this.spawnWorker();
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  private spawnWorker(): void {
    if (typeof Worker === "undefined" || typeof Blob === "undefined") {
      this.useInline("Workers are unavailable");
      return;
    }
    try {
      const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.onmessage = (event: MessageEvent<PublishMessage>) => this.onWorkerMessage(event.data);
      worker.onerror = (event) => {
        event.preventDefault?.();
        if (!this.destroyed) {
          this.useInline(event.message || "Simulation worker failed");
        }
      };
      this.worker = worker;
      this.workerUrl = url;
      worker.postMessage({ type: "cadence", simulationHz: this.simulationHz, publishHz: this.publishHz });
      if (this.paused) worker.postMessage({ type: "pause", paused: true });
      if (this.pendingInit) {
        const msg = this.pendingInit;
        this.pendingInit = null;
        this.post(msg, [msg.pos.buffer, msg.eu.buffer, msg.ev.buffer, msg.radius.buffer]);
      }
    } catch (error) {
      this.useInline(String(error));
    }
  }

  private useInline(reason: string): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    this.inline = new SimulationCore();
    this.options.onFallback?.(reason);
    const msg = this.pendingInit ?? this.lastInit;
    this.pendingInit = null;
    if (msg) {
      this.startInline(msg);
    }
  }

  private startInline(msg: InitMessage): void {
    const core = this.inline ?? new SimulationCore();
    this.inline = core;
    core.reset(msg.pos, msg.eu, msg.ev, msg.radius, msg.config.charge);
    core.setConfig(msg.config);
    core.alpha = msg.alpha;
    core.alphaTarget = 0;
    this.inlinePublishAccumulator = 0;
    this.runInlineLoop();
  }

  private runInlineLoop(): void {
    if (this.inlineTimer !== null || this.destroyed || this.paused) return;
    const tick = () => {
      this.inlineTimer = null;
      const core = this.inline;
      if (!core || this.destroyed || this.paused) return;
      core.step();
      this.inlinePublishAccumulator += this.publishHz;
      if (this.inlinePublishAccumulator >= this.simulationHz || core.alpha <= ALPHA_MIN) {
        this.inlinePublishAccumulator -= this.simulationHz;
        this.options.onFrame(core.positions(), {
          alpha: core.alpha,
          settled: core.isSettled(),
          ticks: core.ticks,
        });
      }
      if (core.alpha > ALPHA_MIN) {
        this.inlineTimer = window.setTimeout(tick, 1000 / this.simulationHz);
      }
    };
    this.inlineTimer = window.setTimeout(tick, 1000 / this.simulationHz);
  }

  private post(message: unknown, transfer?: Transferable[]): void {
    if (this.worker) this.worker.postMessage(message, transfer ?? []);
  }

  private onWorkerMessage(msg: PublishMessage): void {
    if (msg.type !== "publish" || msg.revision !== this.revision) {
      // a stale buffer is simply dropped; positions are monotonically refined
      if (msg.type === "publish") this.returnBuffer(msg.pos);
      return;
    }
    // The worker is now proven healthy. Release the fallback copy so mobile
    // does not retain a second complete simulation for the life of the view.
    this.lastInit = null;
    this.options.onFrame(msg.pos, { alpha: msg.alpha, settled: msg.settled, ticks: msg.ticks });
    this.returnBuffer(msg.pos);
  }

  private returnBuffer(pos: Float32Array): void {
    if (!this.worker || this.destroyed) return;
    this.worker.postMessage({ type: "return", revision: this.revision, pos }, [pos.buffer]);
  }

  /**
   * Hand a freshly built model to the simulation. Positions are seeded by the
   * builder and may already carry the previous layout for surviving nodes.
   * `model.pos` is transferred to the worker, so read geometry from the frame
   * callback afterwards - not from the model.
   */
  update(model: GraphModel, radius: Float32Array, alpha = ALPHA_START): void {
    this.revision = model.revision;
    // Only positions need a private fallback snapshot because the worker takes
    // ownership of model.pos. Topology arrays are immutable and collision
    // radii stay alive in the engine, so retaining references avoids three
    // full-array copies on every large-vault rebuild.
    this.lastInit = {
      type: "init",
      revision: model.revision,
      pos: model.pos.slice(),
      eu: model.eu,
      ev: model.ev,
      radius,
      config: { ...this.config },
      alpha,
    };
    const msg: InitMessage = {
      type: "init",
      revision: model.revision,
      pos: model.pos,
      eu: model.eu.slice(),
      ev: model.ev.slice(),
      radius: radius.slice(),
      config: this.config,
      alpha,
    };
    if (this.worker) {
      this.post(msg, [msg.pos.buffer, msg.eu.buffer, msg.ev.buffer, msg.radius.buffer]);
    } else if (this.inline) {
      this.startInline(msg);
    } else {
      this.pendingInit = msg;
    }
  }

  setConfig(patch: Partial<ForceConfig>, reheat = ALPHA_REHEAT): void {
    this.config = { ...this.config, ...patch };
    if (this.worker) {
      this.post({ type: "config", revision: this.revision, config: this.config, alpha: reheat });
    } else if (this.inline) {
      this.inline.setConfig(this.config);
      this.inline.setCharge(this.config.charge);
      this.inline.reheat(reheat);
      this.runInlineLoop();
    }
  }

  /** Tune physics and transfer frequency without rebuilding the model. */
  setCadence(simulationHz: number, publishHz: number): void {
    this.simulationHz = Math.max(5, Math.min(60, simulationHz));
    this.publishHz = Math.max(5, Math.min(this.simulationHz, publishHz));
    if (this.worker) {
      this.post({ type: "cadence", simulationHz: this.simulationHz, publishHz: this.publishHz });
    } else if (this.inline) {
      if (this.inlineTimer !== null) {
        window.clearTimeout(this.inlineTimer);
        this.inlineTimer = null;
      }
      this.runInlineLoop();
    }
  }

  /** Stop consuming CPU while Obsidian is backgrounded or the pane is hidden. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (this.worker) this.post({ type: "pause", paused });
    if (paused && this.inlineTimer !== null) {
      window.clearTimeout(this.inlineTimer);
      this.inlineTimer = null;
    } else if (!paused) {
      this.runInlineLoop();
    }
  }

  get currentConfig(): ForceConfig {
    return this.config;
  }

  pin(id: number, x: number, y: number, reheat = ALPHA_REHEAT): void {
    if (this.worker) {
      this.post({ type: "pin", revision: this.revision, id, x, y });
      this.post({ type: "alpha", revision: this.revision, alpha: reheat });
      this.post({ type: "alphaTarget", revision: this.revision, value: reheat });
      this.post({ type: "run", revision: this.revision });
    } else if (this.inline) {
      this.inline.pin(id, x, y);
      this.inline.reheat(reheat);
      this.inline.alphaTarget = reheat;
      this.runInlineLoop();
    }
  }

  unpin(id: number): void {
    if (this.worker) {
      this.post({ type: "unpin", revision: this.revision, id });
      this.post({ type: "alphaTarget", revision: this.revision, value: 0 });
    } else if (this.inline) {
      this.inline.unpin(id);
      this.inline.alphaTarget = 0;
      this.runInlineLoop();
    }
  }

  /** Collision radii after a node-size change: no reheat, the layout stays put. */
  setRadius(radius: Float32Array): void {
    if (this.worker) {
      this.post({ type: "radius", revision: this.revision, radius });
    } else if (this.inline) {
      this.inline.setRadius(radius);
    }
  }

  /** re-raise alpha after a hover/selection change so the graph gently moves */
  reheat(alpha = ALPHA_REHEAT): void {
    if (this.worker) {
      this.post({ type: "alpha", revision: this.revision, alpha });
      this.post({ type: "run", revision: this.revision });
    } else if (this.inline) {
      this.inline.reheat(alpha);
      this.runInlineLoop();
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.inlineTimer !== null) {
      window.clearTimeout(this.inlineTimer);
      this.inlineTimer = null;
    }
    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    this.inline = null;
    this.pendingInit = null;
    this.lastInit = null;
  }
}
