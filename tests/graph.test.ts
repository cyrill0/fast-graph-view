import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CLUSTER_OPTIONS,
  DEFAULT_GRAPH_OPTIONS,
  applyNativeOptions,
  cloneGraphOptions,
  mergeData,
  sanitizeClusterOptions,
  sanitizeColorGroups,
} from '../src/settings';
import type { App } from 'obsidian';
import { RawGraph } from '../src/graph/raw';
import { VaultGraphSource } from '../src/graph/source';
import { BackIndex, GraphQuery } from '../src/graph/query';
import { DEFAULT_BUILD_OPTIONS, buildGraph } from '../src/graph/build';
import { NodeKind } from '../src/graph/types';
import { SimulationCore } from '../src/layout/forces';
import { SimulationDriver } from '../src/layout/simulation';
import {
  MobileQualityController,
  initialMobileTier,
  mobileProfile,
} from '../src/mobile/performance';
import { graphPerformanceProfile } from '../src/view/performance';

function createMockApp(): App {
  const files = [
    { path: 'Home.md', basename: 'Home', extension: 'md', stat: { ctime: 1000, mtime: 1000, size: 200 } },
    { path: 'Orphan.md', basename: 'Orphan', extension: 'md', stat: { ctime: 1100, mtime: 1100, size: 120 } },
  ];
  const resolvedLinks: Record<string, Record<string, number>> = {
    'Home.md': {
      'Projects/Alpha.md': 2,
      'Projects/Beta.md': 1,
    },
  };
  const unresolvedLinks: Record<string, Record<string, number>> = {
    'Home.md': {
      'Missing Note': 1,
      constructor: 2,
      toString: 1,
    },
  };
  const tagsByPath: Record<string, string[]> = {
    'Home.md': ['#index', 'index', '#home'],
    'Orphan.md': ['#isolated'],
  };
  for (let i = 0; i < 25; i++) {
    const name = i === 0 ? 'Alpha' : i === 1 ? 'Beta' : `Note-${i}`;
    const path = `Projects/${name}.md`;
    files.push({
      path,
      basename: name,
      extension: 'md',
      stat: { ctime: 2000 + i, mtime: 2000 + i, size: 500 },
    });
    resolvedLinks[path] = i > 0 ? { 'Projects/Alpha.md': 1 } : { 'Home.md': 1 };
    tagsByPath[path] = i % 2 === 0 ? ['#project', '#active'] : ['#project'];
  }
  return {
    vault: {
      getFiles: () => files,
    },
    metadataCache: {
      resolvedLinks,
      unresolvedLinks,
      getFileCache: (f: { path: string }) => ({
        tags: (tagsByPath[f.path] ?? []).map((tag) => ({ tag })),
      }),
    },
  } as unknown as App;
}

function createLargeMockApp(count = 5_000): App {
  const files = Array.from({ length: count }, (_, i) => ({
    path: `Area-${Math.floor(i / 100)}/Note-${i}.md`,
    basename: `Note-${i}`,
    extension: 'md',
    stat: { ctime: i, mtime: i, size: 256 },
  }));
  const resolvedLinks: Record<string, Record<string, number>> = {};
  for (let i = 1; i < files.length; i++) {
    resolvedLinks[files[i].path] = { [files[i - 1].path]: 1 };
  }
  return {
    vault: { getFiles: () => files },
    metadataCache: {
      resolvedLinks,
      unresolvedLinks: {},
      getFileCache: () => null,
    },
  } as unknown as App;
}

void describe('Settings & security sanitization', () => {
  void it('prevents prototype pollution and unknown keys in applyNativeOptions and mergeData', () => {
    const target = cloneGraphOptions(DEFAULT_GRAPH_OPTIONS);
    const malicious: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"unknownKey":"evil","nodeSizeMultiplier":999,"lineSizeMultiplier":-10,"scale":null}',
    );
    applyNativeOptions(target, malicious);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((target as unknown as Record<string, unknown>).unknownKey, undefined);
    assert.equal(target.nodeSizeMultiplier, 5);
    assert.equal(target.lineSizeMultiplier, 0.1);
    assert.equal(target.scale, DEFAULT_GRAPH_OPTIONS.scale);

    const merged = mergeData(malicious);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal('takeover' in merged, false);
    assert.equal(merged.cluster.threshold, DEFAULT_CLUSTER_OPTIONS.threshold);
  });

  void it('clamps cluster options and color groups safely', () => {
    const cluster = sanitizeClusterOptions({
      threshold: -5,
      maxVisibleNodes: 999999,
      maxMetadataNodes: -10,
      maxLabelChars: -5,
      mode: 'invalid' as 'direct',
    });
    assert.equal(cluster.threshold, 1);
    assert.equal(cluster.maxVisibleNodes, 100000);
    assert.equal(cluster.maxMetadataNodes, 0);
    assert.equal(cluster.maxLabelChars, 0);
    assert.equal(cluster.mode, 'direct');
    assert.equal(sanitizeClusterOptions({ maxLabelChars: 9999 }).maxLabelChars, 80);
    assert.equal(
      sanitizeClusterOptions({}).maxLabelChars,
      DEFAULT_CLUSTER_OPTIONS.maxLabelChars,
    );

    const groups = sanitizeColorGroups([
      null,
      { query: 'tag:project', color: { a: 2, rgb: 0x11223344 } },
      { query: 123 },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].query, 'tag:project');
    assert.equal(groups[0].color.a, 1);
    assert.equal(groups[0].color.rgb, 0x223344);
  });
});

void describe('RawGraph indexing & query engine', () => {
  void it('indexes unresolved links with Object.prototype names and deduplicates per-file tags', () => {
    const raw = RawGraph.build(createMockApp());
    assert.ok(raw.unresolvedNames.includes('constructor'));
    assert.ok(raw.unresolvedNames.includes('toString'));
    assert.equal(raw.folderParent[0], -1);
    const projectsId = raw.folderIndex.get('Projects')!;
    assert.equal(raw.folderParent[projectsId], 0);

    const homeId = raw.pathIndex.get('Home.md')!;
    const tagCount = raw.fileTagOff[homeId + 1] - raw.fileTagOff[homeId];
    assert.equal(tagCount, 2);
  });

  void it('guards against deeply nested queries and trailing OR operators', () => {
    const raw = RawGraph.build(createMockApp());
    const back = BackIndex.for(raw);

    const deepQuery = new GraphQuery('('.repeat(400) + 'Home' + ')'.repeat(400), raw, back);
    assert.doesNotThrow(() => deepQuery.matchFile(0));

    const hugeTokens = new GraphQuery(Array.from({ length: 400 }, (_, i) => `term${i}`).join(' OR '), raw, back);
    assert.doesNotThrow(() => hugeTokens.matchFile(0));

    const trailingOr = new GraphQuery('file:Home OR', raw, back);
    const homeId = raw.pathIndex.get('Home.md')!;
    const orphanId = raw.pathIndex.get('Orphan.md')!;
    assert.equal(trailingOr.matchFile(homeId), true);
    assert.equal(trailingOr.matchFile(orphanId), false);

    const whitespaceQuery = new GraphQuery('tag:#project\t-file:Beta\npath:Projects', raw, back);
    const alphaId = raw.pathIndex.get('Projects/Alpha.md')!;
    const betaId = raw.pathIndex.get('Projects/Beta.md')!;
    assert.equal(whitespaceQuery.matchFile(alphaId), true);
    assert.equal(whitespaceQuery.matchFile(betaId), false);
  });
});

void describe('Shared vault snapshot scheduling', () => {
  void it('drops a stale deferred build and emits the newer structural generation', async () => {
    const originalWindow = globalThis.window;
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const handlers: Record<string, () => void> = {};
    let destroyOwner = () => {};

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        },
        setTimeout: (fn: TimerHandler) => nativeSetTimeout(fn, 0),
        clearTimeout: (id: number) => nativeClearTimeout(id as unknown as ReturnType<typeof globalThis.setTimeout>),
      },
    });

    try {
      const base = createMockApp() as unknown as {
        vault: { getFiles(): unknown[] };
        metadataCache: Record<string, unknown>;
      };
      const on = (name: string, callback: () => void) => {
        handlers[name] = callback;
        return { name };
      };
      const app = {
        vault: { getFiles: () => base.vault.getFiles(), on },
        metadataCache: { ...base.metadataCache, on },
      } as unknown as App;
      const owner = {
        registerEvent: () => {},
        register: (cleanup: () => void) => { destroyOwner = cleanup; },
      };
      const source = new VaultGraphSource(app, owner as never);
      const emitted = new Promise<RawGraph>((resolve) => source.subscribe(resolve));
      const stale = source.currentAsync();
      handlers.create();

      assert.equal(await stale, null);
      const fresh = await emitted;
      assert.equal(fresh.fileCount, 27);
      assert.equal(source.built, fresh);
    } finally {
      destroyOwner();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
});

void describe('Graph builder & folder clustering', () => {
  void it('collapses large folders into cluster nodes and supports progressive reveal', () => {
    const raw = RawGraph.build(createMockApp());
    const built = buildGraph(raw, {
      ...DEFAULT_BUILD_OPTIONS,
      clusterEnabled: true,
      clusterThreshold: 20,
      showTags: true,
      showUnresolved: true,
      colorGroups: [
        { query: '', color: { a: 1, rgb: 0xff0000 } },
        { query: 'folder:Projects', color: { a: 1, rgb: 0x00ff00 } },
      ],
    });

    const { model } = built;
    assert.equal(model.clusters.length, 1);
    assert.equal(model.clusters[0].folder, 'Projects');
    assert.equal(model.clusters[0].fileCount, 25);
    assert.equal(model.clusters[0].internalLinks, 24);

    let clusterNode = -1;
    for (let i = 0; i < model.nodeCount; i++) {
      if (model.kind[i] === NodeKind.Cluster) clusterNode = i;
    }
    assert.ok(clusterNode >= 0);
    assert.equal(model.group[clusterNode], 1);

    const revealed = buildGraph(raw, {
      ...DEFAULT_BUILD_OPTIONS,
      clusterEnabled: true,
      clusterThreshold: 20,
      revealOverrides: new Map([['Projects', 10]]),
      carry: { model, pos: model.pos.slice() },
    });
    assert.equal(revealed.model.clusters.length, 1);
    assert.equal(revealed.model.clusters[0].overflow, true);
    assert.equal(revealed.model.clusters[0].fileCount, 15);
  });

  void it('keeps a synthetic 5k-note mobile graph inside the emergency topology budget', () => {
    const started = performance.now();
    const raw = RawGraph.build(createLargeMockApp());
    const profile = mobileProfile('emergency');
    const built = buildGraph(raw, {
      ...DEFAULT_BUILD_OPTIONS,
      clusterEnabled: true,
      clusterThreshold: 15,
      maxVisibleNodes: profile.nodeBudget,
      maxNonFileNodes: profile.metadataBudget,
    });
    assert.ok(built.model.nodeCount <= profile.nodeBudget);
    assert.ok(performance.now() - started < 10_000, 'Synthetic mobile build should complete in under 10 seconds');
  });
});

void describe('Physics simulation & spatial hash stability', () => {
  void it('handles 200 coincident nodes and oversized cluster radii without infinite loops or NaN', () => {
    const n = 200;
    const pos = new Float32Array(n * 2);
    const eu = new Int32Array(n - 1);
    const ev = new Int32Array(n - 1);
    const radius = new Float32Array(n).fill(12);
    radius[0] = 46;
    for (let i = 0; i < n - 1; i++) {
      eu[i] = 0;
      ev[i] = i + 1;
    }

    const sim = new SimulationCore();
    sim.reset(pos, eu, ev, radius, -500);
    for (let tick = 0; tick < 10; tick++) {
      sim.step();
    }
    const out = sim.positions();
    for (let i = 0; i < out.length; i++) {
      assert.ok(Number.isFinite(out[i]), `Expected finite coordinate at index ${i}`);
    }
    assert.equal(sim.ticks, 10);
  });

  void it('keeps an oversized cluster from making the ordinary-node collision pass quadratic', () => {
    const n = 3_000;
    const pos = new Float32Array(n * 2);
    const radius = new Float32Array(n).fill(12);
    radius[0] = 5_000;
    for (let i = 0; i < n; i++) {
      pos[i * 2] = (i % 100) * 180;
      pos[i * 2 + 1] = Math.floor(i / 100) * 180;
    }

    const sim = new SimulationCore();
    sim.reset(pos, new Int32Array(0), new Int32Array(0), radius, -500);
    const started = performance.now();
    sim.step();
    const elapsed = performance.now() - started;

    assert.ok(elapsed < 1_000, `Expected bounded collision tick, got ${elapsed.toFixed(1)} ms`);
    for (const coordinate of sim.positions()) assert.ok(Number.isFinite(coordinate));
  });

  void it('still resolves collisions between two oversized clusters in distant grid cells', () => {
    const pos = new Float32Array([0, 0, 1_500, 0]);
    const radius = new Float32Array([1_000, 900]);
    const sim = new SimulationCore();
    sim.reset(pos, new Int32Array(0), new Int32Array(0), radius, -1);
    sim.setConfig({ centerStrength: 0, linkStrength: 0 });
    sim.step();
    const out = sim.positions();
    assert.ok(out[0] < 0, 'first cluster should move away from the overlap');
    assert.ok(out[2] > 1_500, 'second cluster should move away from the overlap');
  });

  void it('sends adaptive cadence and lifecycle state to the worker', () => {
    const originalWorker = globalThis.Worker;
    const originalWindow = globalThis.window;
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const messages: unknown[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(message: unknown): void { messages.push(message); }
      terminate(): void {}
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        setTimeout: nativeSetTimeout,
        clearTimeout: nativeClearTimeout,
      },
    });
    try {
      const driver = new SimulationDriver({ onFrame: () => {} });
      driver.setCadence(30, 20);
      driver.setPaused(true);
      driver.setPaused(false);
      driver.destroy();
      assert.ok(messages.some((message) =>
        (message as { type?: string; simulationHz?: number; publishHz?: number }).type === 'cadence' &&
        (message as { simulationHz?: number }).simulationHz === 30 &&
        (message as { publishHz?: number }).publishHz === 20));
      assert.ok(messages.some((message) =>
        (message as { type?: string; paused?: boolean }).type === 'pause' &&
        (message as { paused?: boolean }).paused === true));
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
});

void describe('Large desktop graph performance policy', () => {
  void it('keeps normal graphs at full quality and progressively bounds oversized graphs', () => {
    const normal = graphPerformanceProfile(2_000, 1_000);
    assert.equal(normal.simulationHz, 60);
    assert.equal(normal.publishHz, 60);
    assert.equal(normal.maxLabels, 700);
    assert.equal(normal.arrows, true);

    const expanded = graphPerformanceProfile(6_000, 6_000);
    assert.equal(expanded.simulationHz, 30);
    assert.equal(expanded.publishHz, 20);
    assert.equal(expanded.arrows, false);
    assert.ok(expanded.hoverIntervalMs > 0);

    const huge = graphPerformanceProfile(15_000, 10_000, true);
    assert.equal(huge.simulationHz, 20);
    assert.equal(huge.publishHz, 15);
    assert.equal(huge.maxLabels, 100);
    assert.equal(huge.arrows, false);
  });
});

void describe('Mobile adaptive performance policy', () => {
  void it('starts conservatively on low-memory, low-core, and high-fill devices', () => {
    assert.equal(initialMobileTier({
      hardwareConcurrency: 8,
      deviceMemoryGb: 2,
      screenPixels: 1_000_000,
      devicePixelRatio: 2,
    }), 'emergency');
    assert.equal(initialMobileTier({
      hardwareConcurrency: 4,
      deviceMemoryGb: 4,
      screenPixels: 1_000_000,
      devicePixelRatio: 2,
    }), 'low');
    assert.equal(initialMobileTier({
      hardwareConcurrency: 8,
      deviceMemoryGb: 8,
      screenPixels: 1_000_000,
      devicePixelRatio: 2,
    }), 'balanced');
  });

  void it('degrades quickly, recovers slowly, and uses a temporary interaction tier', () => {
    const quality = new MobileQualityController('balanced');
    assert.equal(quality.effective(false).tier, 'balanced');
    assert.equal(quality.effective(true).tier, 'low');

    let now = 0;
    for (let i = 0; i < 30; i++) {
      now += 100;
      quality.sample(30, now);
    }
    assert.equal(quality.tier, 'low');
    assert.ok(mobileProfile(quality.tier).maxLabels < mobileProfile('balanced').maxLabels);
    assert.ok(mobileProfile(quality.tier).simulationHz < mobileProfile('balanced').simulationHz);

    for (let i = 0; i < 400; i++) {
      now += 50;
      quality.sample(8, now);
    }
    assert.equal(quality.tier, 'balanced');
  });
});
