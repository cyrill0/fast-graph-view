/** Force simulation core - the laws are the ones measured out of Obsidian's
 *  own `sim.js` WASM fast path, not the d3 defaults:
 *
 *  | force   | law                                                        |
 *  |---------|------------------------------------------------------------|
 *  | center  | `vx += (0 - x) * centerStrength * alpha`                    |
 *  | link    | d3: `l = (d - linkDistance)/d * alpha * strength`,          |
 *  |         | `strength = linkStrength / min(deg_s, deg_t)`,              |
 *  |         | `bias = deg_s / (deg_s + deg_t)`                            |
 *  | charge  | `vx += dx * (charge * alpha / d2)` - no min/max distance    |
 *  | collide | `l = (r - d)/d * strength`, full impulse both ways, 1 iter  |
 *  | step    | `x += vx * 0.6; vx *= 0.6` (velocityDecay 0.4)               |
 *  | theta   | Barnes-Hut 0.9                                              |
 *
 *  Everything is allocation free after `reset()` so a 2500 node graph can run
 *  at 60 Hz in a worker without generating garbage.
 */

import { BarnesHut } from "./quadtree";

export const ALPHA_START = 1;
export const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
export const ALPHA_MIN = 0.001;
export const ALPHA_REHEAT = 0.3;
/** 1 - velocityDecay, i.e. the 0.6 the native `complete(base, n, 0.6)` passes */
export const VELOCITY_KEEP = 0.6;
export const THETA = 0.9;
export const THETA2 = THETA * THETA;
export const COLLIDE_RADIUS = 60;
export const COLLIDE_STRENGTH = 0.5;

export interface ForceConfig {
  /** already run through the native slider transform */
  centerStrength: number;
  linkStrength: number;
  linkDistance: number;
  /** negative; `-repelStrength^3` */
  charge: number;
  collideRadius: number;
  collideStrength: number;
}

export const DEFAULT_FORCE_CONFIG: ForceConfig = {
  centerStrength: 0.1,
  linkStrength: 1,
  linkDistance: 250,
  charge: -1000,
  collideRadius: COLLIDE_RADIUS,
  collideStrength: COLLIDE_STRENGTH,
};

/** Slider → engine transforms (`F2`/`R2` in the 1.14.4 bundle). */
export function sliderToEngine(value: number): number {
  return (Math.pow(0.01, 1 - value) - 0.01) / 0.99;
}

export function engineToSlider(engine: number): number {
  return 1 - Math.log(engine * 0.99 + 0.01) / Math.log(0.01);
}

export function repelToCharge(repelStrength: number): number {
  const charge = -Math.pow(repelStrength, 3);
  return Math.abs(charge) < 1 ? -1 : charge;
}

const EMPTY = new Float32Array(0);

export class SimulationCore {
  private n = 0;
  private pos: Float32Array = EMPTY;
  private vx: Float32Array = EMPTY;
  private vy: Float32Array = EMPTY;
  private fx: Float32Array = EMPTY;
  private fy: Float32Array = EMPTY;
  private fixed: Uint8Array = new Uint8Array(0);
  private eu: Int32Array = new Int32Array(0);
  private ev: Int32Array = new Int32Array(0);
  /** per link: 1 / min(deg source, deg target) before the slider multiplier */
  private linkBase: Float32Array = new Float32Array(0);
  private linkBias: Float32Array = new Float32Array(0);
  /** per node collide radius */
  private radius: Float32Array = EMPTY;

  private tree = new BarnesHut(4096);
  private charges: Float32Array = EMPTY;

  // spatial hash for the collide pass
  private tableSize = 0;
  private cellHead: Int32Array = new Int32Array(0);
  private nextNode: Int32Array = new Int32Array(0);
  private nodeCellX: Int32Array = new Int32Array(0);
  private nodeCellY: Int32Array = new Int32Array(0);

  alpha = ALPHA_START;
  alphaTarget = 0;
  config: ForceConfig = { ...DEFAULT_FORCE_CONFIG };
  ticks = 0;

  /**
   * Take ownership of the geometry arrays. `pos` must be interleaved x,y and
   * long enough; velocity and pin state are reinitialised.
   */
  reset(pos: Float32Array, eu: Int32Array, ev: Int32Array, radius: Float32Array, charge: number): void {
    this.n = Math.floor(pos.length / 2);
    const n = this.n;
    this.pos = pos;
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
    this.fixed = new Uint8Array(n);
    this.radius = radius.length === n ? radius : new Float32Array(n).fill(COLLIDE_RADIUS);
    this.charges = new Float32Array(n).fill(charge);
    this.eu = eu;
    this.ev = ev;

    const m = eu.length;
    this.linkBase = new Float32Array(m);
    this.linkBias = new Float32Array(m);
    const deg = new Float32Array(n);
    for (let i = 0; i < m; i++) {
      deg[eu[i]]++;
      deg[ev[i]]++;
    }
    for (let i = 0; i < m; i++) {
      const a = deg[eu[i]];
      const b = deg[ev[i]];
      this.linkBase[i] = 1 / Math.max(1, Math.min(a, b));
      this.linkBias[i] = a / Math.max(1, a + b);
    }

    this.tableSize = 1;
    while (this.tableSize < n * 4) this.tableSize <<= 1;
    this.cellHead = new Int32Array(this.tableSize);
    this.nextNode = new Int32Array(n);
    this.nodeCellX = new Int32Array(n);
    this.nodeCellY = new Int32Array(n);
    this.ticks = 0;
  }

  /** Keep positions and pins, adopt new velocity arrays (after a rebuild). */
  setCharge(charge: number): void {
    if (!this.charges.length) return;
    this.charges.fill(charge);
  }

  setConfig(patch: Partial<ForceConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Collision radii only - a size change must not reheat or move anything. */
  setRadius(radius: Float32Array): void {
    if (radius.length !== this.n) return;
    this.radius = radius;
  }

  /** Alpha only ever goes up, exactly like the native worker's `{alpha}` message. */
  reheat(alpha: number): void {
    if (alpha > this.alpha) this.alpha = alpha;
  }

  pin(i: number, x: number, y: number): void {
    if (i < 0 || i >= this.n) return;
    this.fixed[i] = 1;
    this.fx[i] = x;
    this.fy[i] = y;
    this.pos[i * 2] = x;
    this.pos[i * 2 + 1] = y;
    this.vx[i] = 0;
    this.vy[i] = 0;
  }

  unpin(i: number): void {
    if (i < 0 || i >= this.n) return;
    this.fixed[i] = 0;
  }

  isSettled(): boolean {
    return this.alpha <= ALPHA_MIN;
  }

  /** number of simulated nodes */
  get count(): number {
    return this.n;
  }

  /** live interleaved x,y buffer - do not mutate between ticks */
  positions(): Float32Array {
    return this.pos;
  }

  /** One full tick: forces in the native order, then the 0.6 integration. */
  step(): void {
    const n = this.n;
    if (!n) return;
    this.alpha += (this.alphaTarget - this.alpha) * ALPHA_DECAY;
    const alpha = this.alpha;
    const { centerStrength, linkStrength, linkDistance, collideRadius, collideStrength } = this.config;
    const pos = this.pos;
    const vx = this.vx;
    const vy = this.vy;

    // --- center (forceX + forceY toward 0) ---
    if (centerStrength > 0) {
      const k = centerStrength * alpha;
      for (let i = 0; i < n; i++) {
        vx[i] -= pos[i * 2] * k;
        vy[i] -= pos[i * 2 + 1] * k;
      }
    }

    // --- link ---
    if (linkStrength > 0) {
      const m = this.eu.length;
      const base = this.linkBase;
      const bias = this.linkBias;
      for (let i = 0; i < m; i++) {
        const a = this.eu[i];
        const b = this.ev[i];
        let dx = pos[b * 2] + vx[b] - pos[a * 2] - vx[a];
        let dy = pos[b * 2 + 1] + vy[b] - pos[a * 2 + 1] - vy[a];
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1e-6) {
          dx = jitter(this.ticks + i);
          dy = jitter(this.ticks + i + 7919);
          d = Math.sqrt(dx * dx + dy * dy);
        }
        const l = ((d - linkDistance) / d) * alpha * linkStrength * base[i];
        const px = dx * l;
        const py = dy * l;
        const w = bias[i];
        vx[b] -= px * w;
        vy[b] -= py * w;
        vx[a] += px * (1 - w);
        vy[a] += py * (1 - w);
      }
    }

    // --- charge ---
    this.tree.build(pos, n, this.charges);
    this.tree.applyCharge(vx, vy, alpha, THETA2);

    // --- collide ---
    this.collide(collideRadius, collideStrength);

    // --- integrate ---
    for (let i = 0; i < n; i++) {
      const k = i * 2;
      if (this.fixed[i]) {
        pos[k] = this.fx[i];
        pos[k + 1] = this.fy[i];
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      let x = pos[k] + vx[i] * VELOCITY_KEEP;
      let y = pos[k + 1] + vy[i] * VELOCITY_KEEP;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        x = jitter(i) * 40;
        y = jitter(i + 31) * 40;
        vx[i] = 0;
        vy[i] = 0;
      }
      pos[k] = x;
      pos[k + 1] = y;
      vx[i] *= VELOCITY_KEEP;
      vy[i] *= VELOCITY_KEEP;
    }
    this.ticks++;
  }

  /**
   * Uniform-grid collision relaxation. Cells stay tied to the normal node
   * diameter: sizing the whole grid from the largest folder cluster used to
   * put thousands of ordinary nodes in one bucket and turn a tick quadratic.
   *
   * A pair is owned by its larger node (or the lower index for equal radii).
   * That node widens only its own search window, so an oversized cluster still
   * finds every node it can touch while ordinary nodes retain a 3x3 lookup.
   */
  private collide(baseRadius: number, strength: number): void {
    const n = this.n;
    const size = this.tableSize;
    if (!size || !n) return;
    const pos = this.pos;
    const vx = this.vx;
    const vy = this.vy;
    const radius = this.radius;
    const head = this.cellHead;
    const next = this.nextNode;
    const cellX = this.nodeCellX;
    const cellY = this.nodeCellY;
    const mask = size - 1;

    const cell = Math.max(10, baseRadius * 2);
    const invCell = 1 / cell;
    head.fill(-1);

    for (let i = 0; i < n; i++) {
      const cx = Math.floor((pos[i * 2] + vx[i]) * invCell);
      const cy = Math.floor((pos[i * 2 + 1] + vy[i]) * invCell);
      cellX[i] = cx;
      cellY[i] = cy;
      const slot = hashCell(cx, cy) & mask;
      next[i] = head[slot];
      head[slot] = i;
    }

    for (let i = 0; i < n; i++) {
      const ri = radius[i] || baseRadius;
      const xi = pos[i * 2] + vx[i];
      const yi = pos[i * 2 + 1] + vy[i];
      const cx = cellX[i];
      const cy = cellY[i];
      // This node owns only pairs whose other radius is <= ri, so 2 * ri is
      // the largest possible contact distance (including cluster/cluster).
      const reach = Math.max(1, Math.ceil(ri * 2 * invCell));
      for (let oy = -reach; oy <= reach; oy++) {
        const gy = cy + oy;
        for (let ox = -reach; ox <= reach; ox++) {
          const gx = cx + ox;
          let j = head[hashCell(gx, gy) & mask];
          while (j !== -1) {
            if (j !== i && cellX[j] === gx && cellY[j] === gy) {
              const rj = radius[j] || baseRadius;
              // The larger disc owns the pair. Equal discs use the lower id,
              // ensuring one impulse rather than the previous duplicate pass.
              if (ri < rj || (ri === rj && i > j)) {
                j = next[j];
                continue;
              }
              const rr = ri + rj;
              let dx = xi - (pos[j * 2] + vx[j]);
              let dy = yi - (pos[j * 2 + 1] + vy[j]);
              const d2 = dx * dx + dy * dy;
              let d = d2 < rr * rr ? Math.sqrt(d2) : rr;
              if (d < 1e-6) {
                dx = jitter(i * 31 + j);
                dy = jitter(i * 17 + j + 5);
                d = Math.sqrt(dx * dx + dy * dy);
              }
              if (d < rr && d > 0) {
                // Pairs were historically visited from both ends. Doubling
                // the one canonical impulse retains approximately the same
                // relaxation strength without doing duplicate work.
                const l = ((rr - d) / d) * strength * 2;
                const px = dx * l;
                const py = dy * l;
                vx[i] += px;
                vy[i] += py;
                vx[j] -= px;
                vy[j] -= py;
              }
            }
            j = next[j];
          }
        }
      }
    }
  }
}

function hashCell(cx: number, cy: number): number {
  const a = (cx * 0x9e3779b1) | 0;
  const b = (cy * 0x85ebca77) | 0;
  let h = (a ^ (b * 0x27d4eb2d)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 0x2545f491);
  return (h ^ (h >>> 15)) | 0;
}

/** Cheap deterministic jitter in place of d3's jiggle(). */
function jitter(seed: number): number {
  let s = (seed * 1664525 + 1013904223) >>> 0;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return ((s >>> 0) / 4294967296 - 0.5) * 2e-3;
}
