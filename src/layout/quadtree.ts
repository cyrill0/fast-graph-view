/**
 * Array-backed Barnes-Hut quadtree.
 *
 * Cells live in parallel typed arrays, children are always at higher indices
 * than their parent, and mass / centre of charge are folded up in one reverse
 * pass. That keeps a 2500 point tree rebuildable in well under a millisecond
 * with no per-tick allocation, which is what lets the simulation afford 60 Hz.
 */

/** duplicate or near-duplicate points share a leaf instead of splitting forever */
const MAX_LEAF_COUNT = 4;

export class BarnesHut {
  private x0!: Float32Array;
  private y0!: Float32Array;
  private x1!: Float32Array;
  private y1!: Float32Array;
  /** first child slot, -1 for leaves */
  private child!: Int32Array;
  /** first point of the leaf chain, -1 when empty */
  private head!: Int32Array;
  /** point count per cell (leaf chains during build, subtree totals after fold) */
  private mass!: Int32Array;
  private cx!: Float32Array;
  private cy!: Float32Array;
  /** summed charge of the cell */
  private value!: Float32Array;
  /** chain links between points that share a leaf */
  private next: Int32Array = new Int32Array(0);

  private pos: Float32Array | null = null;
  private charge: Float32Array | null = null;
  /** depth-first traversal buffer reused for every point */
  private stack: Int32Array = new Int32Array(4096);

  private used = 0;
  private root = 0;
  private capacity = 0;
  private minSize = 1e-4;

  constructor(capacity = 4096) {
    this.capacity = Math.max(256, capacity);
    this.allocate(this.capacity);
  }

  private allocate(capacity: number): void {
    this.x0 = new Float32Array(capacity);
    this.y0 = new Float32Array(capacity);
    this.x1 = new Float32Array(capacity);
    this.y1 = new Float32Array(capacity);
    this.child = new Int32Array(capacity);
    this.head = new Int32Array(capacity);
    this.mass = new Int32Array(capacity);
    this.cx = new Float32Array(capacity);
    this.cy = new Float32Array(capacity);
    this.value = new Float32Array(capacity);
    this.child.fill(-1);
    this.head.fill(-1);
  }

  private grow(): void {
    const nextCapacity = this.capacity * 2;
    const copyFloat = (src: Float32Array): Float32Array => {
      const dst = new Float32Array(nextCapacity);
      dst.set(src);
      return dst;
    };
    const copyInt = (src: Int32Array): Int32Array => {
      const dst = new Int32Array(nextCapacity);
      dst.set(src);
      return dst;
    };
    this.x0 = copyFloat(this.x0);
    this.y0 = copyFloat(this.y0);
    this.x1 = copyFloat(this.x1);
    this.y1 = copyFloat(this.y1);
    this.cx = copyFloat(this.cx);
    this.cy = copyFloat(this.cy);
    this.value = copyFloat(this.value);
    const child = copyInt(this.child);
    const head = copyInt(this.head);
    this.mass = copyInt(this.mass);
    child.fill(-1, this.capacity);
    head.fill(-1, this.capacity);
    this.child = child;
    this.head = head;
    this.capacity = nextCapacity;
  }

  private alloc(x0: number, y0: number, x1: number, y1: number): number {
    if (this.used >= this.capacity) this.grow();
    const id = this.used++;
    this.x0[id] = x0;
    this.y0[id] = y0;
    this.x1[id] = x1;
    this.y1[id] = y1;
    this.child[id] = -1;
    this.head[id] = -1;
    this.mass[id] = 0;
    return id;
  }

  /** Rebuild the tree over `pos` (interleaved x,y) with per-point charge `charge`. */
  build(pos: Float32Array, count: number, charge: Float32Array): void {
    this.used = 0;
    this.pos = pos;
    this.charge = charge;
    this.countHint = count;
    if (this.next.length < count) this.next = new Int32Array(Math.max(count, 4096));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (minX === Infinity) {
      this.root = this.alloc(0, 0, 1, 1);
      return;
    }
    const size = Math.max(maxX - minX, maxY - minY, 1);
    // cell bounds are float32: below the resolution of the largest coordinate a child is an exact
    // copy of its parent, so that resolution is where splitting has to stop
    const magnitude = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY), 1);
    this.minSize = Math.max(size * 1e-7, magnitude * 2 ** -23);
    this.root = this.alloc(minX, minY, minX + size, minY + size);

    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(pos[i * 2]) || !Number.isFinite(pos[i * 2 + 1])) continue;
      this.insertFrom(this.root, i);
    }
    this.foldUp();
  }

  /** descend from `cell` placing point `id`; splits leaves as needed */
  private insertFrom(cell: number, id: number): void {
    const pos = this.pos!;
    const x = pos[id * 2];
    const y = pos[id * 2 + 1];
    let node = cell;
    for (let guard = 0; guard < 128; guard++) {
      const base = this.child[node];
      if (base !== -1) {
        const mx = (this.x0[node] + this.x1[node]) / 2;
        const my = (this.y0[node] + this.y1[node]) / 2;
        node = base + ((x >= mx ? 1 : 0) | (y >= my ? 2 : 0));
        continue;
      }
      if (this.head[node] === -1) {
        this.head[node] = id;
        this.next[id] = -1;
        this.mass[node] = 1;
        return;
      }
      const wide = this.x1[node] - this.x0[node];
      if (wide > this.minSize && this.mass[node] < MAX_LEAF_COUNT) {
        // split, move the existing chain down a level, then place `id`
        const children = this.split(node);
        let p = this.head[node];
        this.head[node] = -1;
        this.mass[node] = 0;
        while (p !== -1) {
          const following = this.next[p];
          this.insertFrom(children, p);
          p = following;
        }
        this.insertFrom(children, id);
        return;
      }
      this.next[id] = this.head[node];
      this.head[node] = id;
      this.mass[node]++;
      return;
    }
    // pathological depth: chain the point where it stands
    this.next[id] = this.head[node];
    this.head[node] = id;
    this.mass[node]++;
  }

  private split(cell: number): number {
    const base = this.used;
    const x0 = this.x0[cell];
    const y0 = this.y0[cell];
    const x1 = this.x1[cell];
    const y1 = this.y1[cell];
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    this.alloc(x0, y0, mx, my);
    this.alloc(mx, y0, x1, my);
    this.alloc(x0, my, mx, y1);
    this.alloc(mx, my, x1, y1);
    this.child[cell] = base;
    return base;
  }

  /** mass, centre of mass and summed charge, children first */
  private foldUp(): void {
    const pos = this.pos!;
    const charge = this.charge!;
    for (let id = this.used - 1; id >= 0; id--) {
      if (this.child[id] !== -1) {
        const base = this.child[id];
        let m = 0;
        let sx = 0;
        let sy = 0;
        let v = 0;
        for (let k = 0; k < 4; k++) {
          const c = base + k;
          const cm = this.mass[c];
          if (!cm) continue;
          m += cm;
          sx += this.cx[c] * cm;
          sy += this.cy[c] * cm;
          v += this.value[c];
        }
        this.mass[id] = m;
        this.cx[id] = m ? sx / m : 0;
        this.cy[id] = m ? sy / m : 0;
        this.value[id] = v;
        continue;
      }
      let m = 0;
      let sx = 0;
      let sy = 0;
      let v = 0;
      let p = this.head[id];
      while (p !== -1) {
        m++;
        sx += pos[p * 2];
        sy += pos[p * 2 + 1];
        v += charge[p];
        p = this.next[p];
      }
      this.mass[id] = m;
      this.cx[id] = m ? sx / m : 0;
      this.cy[id] = m ? sy / m : 0;
      this.value[id] = v;
    }
  }

  /**
   * Add charge accelerations to `vx`/`vy` for every point.
   * A cell stands in for its contents when width^2 / distance^2 < theta^2,
   * matching the native graph's Barnes-Hut theta of 0.9.
   */
  applyCharge(
    vx: Float32Array,
    vy: Float32Array,
    alpha: number,
    theta2: number,
  ): void {
    const pos = this.pos!;
    const charge = this.charge!;
    const count = this.countHint;
    const stack = this.stack;
    for (let i = 0; i < count; i++) {
      const px = pos[i * 2];
      const py = pos[i * 2 + 1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      let top = 0;
      stack[top++] = this.root;
      while (top > 0) {
        const cell = stack[--top];
        if (this.mass[cell] === 0) continue;
        const isLeaf = this.child[cell] === -1;
        if (isLeaf) {
          let p = this.head[cell];
          while (p !== -1) {
            if (p !== i) {
              const ox = pos[p * 2] - px;
              const oy = pos[p * 2 + 1] - py;
              const l = ox * ox + oy * oy;
              if (l > 0) {
                const w = (charge[p] * alpha) / l;
                vx[i] += ox * w;
                vy[i] += oy * w;
              }
            }
            p = this.next[p];
          }
          continue;
        }
        const dx = this.cx[cell] - px;
        const dy = this.cy[cell] - py;
        const l = dx * dx + dy * dy;
        const width = this.x1[cell] - this.x0[cell];
        if (l > 0 && (width * width) / l < theta2) {
          const w = (this.value[cell] * alpha) / l;
          vx[i] += dx * w;
          vy[i] += dy * w;
          continue;
        }
        if (top + 4 > stack.length) continue;
        const base = this.child[cell];
        stack[top++] = base;
        stack[top++] = base + 1;
        stack[top++] = base + 2;
        stack[top++] = base + 3;
      }
    }
  }

  /** number of points the last build held */
  countHint = 0;

  /** debug helper - number of allocated cells */
  get cells(): number {
    return this.used;
  }
}
