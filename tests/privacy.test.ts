import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App } from 'obsidian';
import { VaultGraphSource } from '../src/graph/source';
import type { RawGraph } from '../src/graph/raw';
import { DEFAULT_DATA, mergeData } from '../src/settings';
import { downloadScreenshot } from '../src/view/screenshot';

function sourceHarness(allowed = false) {
  const originalWindow = globalThis.window;
  const frames: FrameRequestCallback[] = [];
  const timers = new Map<number, () => void>();
  const handlers: Record<string, () => void> = {};
  const reads = { files: 0, links: 0, tags: 0 };
  let timerId = 0;
  let destroyOwner = () => {};
  const on = (name: string, callback: () => void) => {
    handlers[name] = callback;
    return { name };
  };
  const app = {
    vault: {
      on,
      getFiles: () => {
        reads.files++;
        return [{ path: 'Private.md', basename: 'Private', extension: 'md' }];
      },
    },
    metadataCache: {
      on,
      get resolvedLinks() { reads.links++; return {}; },
      get unresolvedLinks() { reads.links++; return {}; },
      getFileCache: () => { reads.tags++; return null; },
    },
  } as unknown as App;
  const owner = {
    registerEvent: () => {},
    register: (cleanup: () => void) => { destroyOwner = cleanup; },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
      setTimeout: (callback: () => void) => {
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  });
  const source = new VaultGraphSource(app, owner as never, allowed);
  const runTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  return {
    source, reads, handlers, frames, timers, runTimers,
    teardown: () => destroyOwner(),
    runFrame: () => {
      const callback = frames.shift();
      assert.ok(callback, 'Expected a queued frame');
      callback(0);
      runTimers();
    },
    destroy: () => {
      destroyOwner();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    },
  };
}

void describe('Vault metadata consent', () => {
  void it('defaults to denied for new installs, upgrades and invalid or inherited values', () => {
    assert.equal(DEFAULT_DATA.allowVaultEnumeration, false);
    const inherited: unknown = Object.create({ allowVaultEnumeration: true });
    for (const saved of [null, {}, { graph: {} }, inherited,
      ...[false, 'true', 1, {}, []].map((value) => ({ allowVaultEnumeration: value }))]) {
      assert.equal(mergeData(saved).allowVaultEnumeration, false);
    }
    assert.equal(mergeData({ allowVaultEnumeration: true }).allowVaultEnumeration, true);
  });

  void it('does not enumerate files or inspect cached metadata through any build entry point without consent', async () => {
    const h = sourceHarness();
    try {
      h.source.subscribe(() => {});
      assert.equal(h.source.enabled, false);
      assert.equal(h.source.current(), null);
      assert.equal(await h.source.currentAsync(), null);
      assert.equal(h.source.refresh(), null);
      for (const event of ['create', 'delete', 'rename', 'changed', 'resolved']) h.handlers[event]();
      assert.deepEqual(h.reads, { files: 0, links: 0, tags: 0 });
      assert.equal(h.frames.length, 0);
      assert.equal(h.timers.size, 0);
    } finally { h.destroy(); }
  });

  void it('builds after consent, shares the snapshot, and clears subscribers on revocation', async () => {
    const h = sourceHarness();
    try {
      h.source.setAccessAllowed(true);
      assert.equal(h.frames.length, 0, 'Consent alone must not start background indexing');
      const emitted: (RawGraph | null)[] = [];
      h.source.subscribe((raw) => emitted.push(raw));
      const pending = h.source.currentAsync();
      assert.equal(h.source.currentAsync(), pending);
      h.runFrame();
      const raw = await pending;
      assert.equal(raw?.fileCount, 1);
      assert.equal(h.source.current(), raw);
      assert.equal(await h.source.currentAsync(), raw);
      assert.equal(h.reads.files, 1);

      h.handlers.changed();
      assert.equal(h.timers.size, 1);
      h.source.setAccessAllowed(false);
      assert.equal(h.timers.size, 0);
      assert.equal(h.source.built, null);
      assert.equal(emitted.at(-1), null);
      assert.equal(h.source.current(), null);
      assert.equal(await h.source.currentAsync(), null);
      assert.equal(h.source.refresh(), null);
      h.handlers.resolved();
      h.runTimers();
      assert.equal(h.reads.files, 1);
    } finally { h.destroy(); }
  });

  void it('cancels deferred builds before file enumeration when consent is revoked', async () => {
    const h = sourceHarness(true);
    try {
      h.source.subscribe(() => {});
      const pending = h.source.currentAsync();
      h.source.setAccessAllowed(false);
      h.runFrame();
      assert.equal(await pending, null);
      assert.deepEqual(h.reads, { files: 0, links: 0, tags: 0 });
    } finally { h.destroy(); }
  });

  void it('does not let an obsolete promise replace a fresh build after rapid consent changes', async () => {
    const h = sourceHarness(true);
    try {
      const emitted: (RawGraph | null)[] = [];
      h.source.subscribe((raw) => emitted.push(raw));
      const stale = h.source.currentAsync();
      h.source.setAccessAllowed(false);
      h.source.setAccessAllowed(true);
      const fresh = h.source.currentAsync();
      assert.notEqual(fresh, stale);
      h.runFrame();
      assert.equal(await stale, null);
      assert.equal(h.source.currentAsync(), fresh, 'An old finalizer must not clear the fresh promise');
      h.runFrame();
      const raw = await fresh;
      assert.equal(raw?.fileCount, 1);
      assert.equal(emitted.at(-1), raw);
      assert.equal(h.reads.files, 1);
    } finally { h.destroy(); }
  });

  void it('cancels queued work and drops the snapshot when the last pane closes', async () => {
    const h = sourceHarness(true);
    try {
      const close = h.source.subscribe(() => {});
      const pending = h.source.currentAsync();
      close();
      h.runFrame();
      assert.equal(await pending, null);
      assert.equal(h.reads.files, 0);

      const closeAgain = h.source.subscribe(() => {});
      const next = h.source.currentAsync();
      h.runFrame();
      assert.equal((await next)?.fileCount, 1);
      closeAgain();
      assert.equal(h.source.built, null);
    } finally { h.destroy(); }
  });

  void it('does not enumerate after plugin teardown', async () => {
    const h = sourceHarness(true);
    try {
      h.source.subscribe(() => {});
      const pending = h.source.currentAsync();
      h.teardown();
      h.runFrame();
      assert.equal(await pending, null);
      assert.equal(h.source.current(), null);
      assert.equal(h.source.refresh(), null);
      assert.equal(await h.source.currentAsync(), null);
      assert.equal(h.reads.files, 0);
    } finally { h.destroy(); }
  });
});

void describe('Screenshot download', () => {
  void it('downloads the generated PNG through the owning document and removes the temporary link', () => {
    const actions: string[] = [];
    const link = {
      href: '', download: '',
      click: () => actions.push('click'),
      remove: () => actions.push('remove'),
    };
    const doc = {
      body: {
        createEl: (tag: string, options: { href: string; attr: { download: string } }) => {
          assert.equal(tag, 'a');
          link.href = options.href;
          link.download = options.attr.download;
          actions.push('append');
          return link;
        },
      },
    } as unknown as Document;
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    downloadScreenshot(doc, png);
    assert.equal(link.href, png);
    assert.equal(link.download, 'fast-graph-view.png');
    assert.deepEqual(actions, ['append', 'click', 'remove']);
    assert.throws(() => downloadScreenshot(doc, 'https://example.com/image.png'), /Invalid PNG/);
    assert.deepEqual(actions, ['append', 'click', 'remove']);
  });

  void it('removes the temporary download link even if the click fails', () => {
    let removed = false;
    const doc = {
      body: {
        createEl: () => ({
          click: () => { throw new Error('Download blocked'); },
          remove: () => { removed = true; },
        }),
      },
    } as unknown as Document;
    assert.throws(() => downloadScreenshot(doc, 'data:image/png;base64,AA=='), /Download blocked/);
    assert.equal(removed, true);
  });
});
