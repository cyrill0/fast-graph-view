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
  | { type: "run"; revision: number }
  | { type: "stop" };

declare const self: Worker & { postMessage(message: unknown, transfer?: Transferable[]): void };

const core = new SimulationCore();
let revision = -1;
/** buffer handed back by the main thread and awaiting reuse */
let spare: Float32Array | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 1000 / 60;

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
    clearInterval(timer);
    timer = null;
  }
}

function start(): void {
  stop();
  timer = setInterval(() => {
    core.step();
    publish();
    if (core.alpha <= ALPHA_MIN) stop();
  }, TICK_MS);
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
