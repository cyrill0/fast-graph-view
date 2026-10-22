/** One vault snapshot, shared by every graph leaf.

 *  `RawGraph.build` reads the whole metadata cache, which costs a few hundred
 *  milliseconds on a 24k-note vault - far too much to redo for each open pane or
 *  each keystroke. So the snapshot lives here, is rebuilt at most once per burst
 *  of vault events, and every view reads the same immutable object.
 *
 *  Two delays, because two things change:
 *
 *  - structure (create / delete / rename) shifts the node set, rebuilt after
 *    400 ms of quiet;
 *  - content (a note being typed into) only moves link targets, rebuilt after
 *    1.5 s of quiet so a long edit costs one rebuild, not one per save.
 *
 *  Nothing is built at all while no graph leaf is open.
 */

import type { App, Component, EventRef } from "obsidian";
import { RawGraph } from "./raw";

const STRUCTURAL_DELAY = 400;
const CONTENT_DELAY = 1500;

export type RawListener = (raw: RawGraph) => void;

export class VaultGraphSource {
  private raw: RawGraph | null = null;
  private timer: number | null = null;
  private pendingStructural = false;
  private generation = 0;
  private buildPromise: Promise<RawGraph | null> | null = null;
  private listeners = new Set<RawListener>();
  private refs: EventRef[] = [];
  private destroyed = false;

  constructor(private readonly app: App, owner: Component) {
    const structural = () => this.mark(true);
    const content = () => this.mark(false);
    this.refs.push(
      app.vault.on("create", structural),
      app.vault.on("delete", structural),
      app.vault.on("rename", structural),
      app.metadataCache.on("changed", content),
      app.metadataCache.on("resolved", structural),
    );
    for (const ref of this.refs) owner.registerEvent(ref);
    owner.register(() => this.destroy());
  }

  /** Current snapshot, built on first use. */
  current(): RawGraph {
    if (!this.raw) this.raw = RawGraph.build(this.app);
    return this.raw;
  }

  /**
   * Let the pane and its controls paint before indexing a large vault. A single
   * deferred build is shared by every leaf, and generation checks prevent an
   * obsolete snapshot from winning after a newer vault event.
   */
  currentAsync(): Promise<RawGraph | null> {
    if (this.raw) return Promise.resolve(this.raw);
    return this.buildDeferred(false);
  }

  get built(): RawGraph | null {
    return this.raw;
  }

  /** Force a synchronous rebuild, e.g. when a leaf opens after a vault change. */
  refresh(): RawGraph {
    this.cancelTimer();
    this.generation++;
    this.raw = RawGraph.build(this.app);
    this.emit();
    return this.raw;
  }

  subscribe(listener: RawListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private mark(structural: boolean): void {
    this.generation++;
    if (this.destroyed || this.listeners.size === 0) {
      // nobody is looking: drop the snapshot and rebuild when a leaf comes back
      this.raw = null;
      return;
    }
    this.pendingStructural = this.pendingStructural || structural;
    const delay = this.pendingStructural ? STRUCTURAL_DELAY : CONTENT_DELAY;
    if (this.timer !== null) {
      // never postpone a pending structural rebuild for a later content event
      if (delay <= STRUCTURAL_DELAY) this.cancelTimer();
      else return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      void this.buildDeferred(true);
    }, delay);
  }

  private buildDeferred(emit: boolean): Promise<RawGraph | null> {
    if (this.buildPromise) return this.buildPromise;
    const generation = this.generation;
    this.buildPromise = new Promise<void>((resolve) => {
      // Two queues guarantee at least one browser paint before the synchronous
      // metadata-cache snapshot. This removes the expensive work from view-open.
      requestAnimationFrame(() => window.setTimeout(resolve, 0));
    })
      .then(() => {
        if (this.destroyed || generation !== this.generation) return this.raw;
        const next = RawGraph.build(this.app);
        if (this.destroyed || generation !== this.generation) return this.raw;
        this.raw = next;
        this.pendingStructural = false;
        if (emit) this.emit();
        return next;
      })
      .finally(() => {
        this.buildPromise = null;
      });
    return this.buildPromise;
  }

  private emit(): void {
    const raw = this.raw;
    if (!raw) return;
    for (const listener of this.listeners) listener(raw);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private destroy(): void {
    this.destroyed = true;
    this.generation++;
    this.cancelTimer();
    this.listeners.clear();
  }
}
