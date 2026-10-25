/** Simulation worker entry point.
 *
 *  esbuild bundles this into a standalone IIFE that `simulation.ts` turns into
 *  a blob worker, so nothing here may touch the DOM. Physics never runs on the
 *  main thread - Obsidian does the same with `new Worker("/sim.js")`.
 */

import { SimulationCore } from "./forces";
import type { ForceConfig } from "./forces";
import { ALPHA_MIN } from "./forces";

export interface InitMessage {
  type: "init";
  revision: number;
  pos: Float32Array;
  eu: Int32Array;
  ev: Int32Array;
  radius: Float32Array;
  config: ForceConfig;
  alpha: number;
}

export interface PublishMessage {
  type: "publish";
  revision: number;
  pos: Float32Array;
  alpha: number;
  settled: boolean;
  ticks: number;
}

type WorkerIn =
  | InitMessage
  | { type: "config"; revision: number; config: Partial<ForceConfig>; alpha?: number }
  | { type: "alpha"; revision: number; alpha: number }
  | { type: "alphaTarget"; revision: number; value: number }
  | { type: "pin"; revision: number; id: number; x: number; y: number }
  | { type: "unpin"; revision: number; id: number }
  | { type: "radius"; revision: number; radius: Float32Array }
  | { type: "return"; revision: number; pos: Float32Array }
  | { type: "cadence"; simulationHz: number; publishHz: number }
  | { type: "pause"; paused: boolean }
  | { type: "run"; revision: number }
  | { type: "stop" };

declare const self: Worker & {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  setInterval(handler: () => void, timeout?: number): number;
  clearInterval(id?: number): void;
};

const core = new SimulationCore();
let revision = -1;
/** buffer handed back by the main thread and awaiting reuse */
let spare: Float32Array | null = null;
let timer: ReturnType<typeof self.setInterval> | null = null;
let simulationHz = 60;
let publishHz = 60;
let publishAccumulator = 0;
let paused = false;

function publish(): void {
  const out = spare ?? new Float32Array(core.count * 2);
  spare = null;
  out.set(core.positions());
  const ticks = core.ticks;
  const alpha = core.alpha;
  const settled = alpha <= ALPHA_MIN;
  const message: PublishMessage = { type: "publish", revision, pos: out, alpha, settled, ticks };
  self.postMessage(message, [out.buffer]);
}

function stop(): void {
  if (timer !== null) {
    self.clearInterval(timer);
    timer = null;
  }
}

function start(): void {
  stop();
  if (paused) return;
  publishAccumulator = 0;
  timer = self.setInterval(() => {
    core.step();
    publishAccumulator += publishHz;
    if (publishAccumulator >= simulationHz || core.alpha <= ALPHA_MIN) {
      publishAccumulator -= simulationHz;
      publish();
    }
    if (core.alpha <= ALPHA_MIN) stop();
  }, 1000 / simulationHz);
}

self.onmessage = (event: MessageEvent<WorkerIn>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init": {
      revision = msg.revision;
      core.reset(msg.pos, msg.eu, msg.ev, msg.radius, msg.config.charge);
      core.setConfig(msg.config);
      core.alpha = msg.alpha;
      core.alphaTarget = 0;
      spare = null;
      start();
      break;
    }
    case "config": {
      if (msg.revision !== revision) break;
      core.setConfig(msg.config);
      if (msg.config.charge !== undefined) core.setCharge(msg.config.charge);
      if (msg.alpha !== undefined) core.reheat(msg.alpha);
      start();
      break;
    }
    case "alpha": {
      if (msg.revision !== revision) break;
      core.reheat(msg.alpha);
      start();
      break;
    }
    case "pin": {
      if (msg.revision !== revision) break;
      core.pin(msg.id, msg.x, msg.y);
      break;
    }
    case "unpin": {
      if (msg.revision !== revision) break;
      core.unpin(msg.id);
      break;
    }
    case "radius": {
      if (msg.revision !== revision) break;
      core.setRadius(msg.radius);
      break;
    }
    case "return": {
      if (msg.revision !== revision) break;
      if (msg.pos.length >= core.count * 2) spare = msg.pos;
      break;
    }
    case "cadence": {
      simulationHz = Math.max(5, Math.min(60, msg.simulationHz));
      publishHz = Math.max(5, Math.min(simulationHz, msg.publishHz));
      if (timer !== null) start();
      break;
    }
    case "pause": {
      paused = msg.paused;
      if (paused) stop();
      else if (core.alpha > ALPHA_MIN) start();
      break;
    }
    case "run": {
      if (msg.revision !== revision) break;
      start();
      break;
    }
    case "alphaTarget": {
      if (msg.revision !== revision) break;
      core.alphaTarget = msg.value;
      if (msg.value > 0) core.reheat(msg.value);
      start();
      break;
    }
    case "stop":
      stop();
      break;
  }
};
