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
import { BackIndex, GraphQuery } from '../src/graph/query';
import { DEFAULT_BUILD_OPTIONS, buildGraph } from '../src/graph/build';
import { NodeKind } from '../src/graph/types';
import { SimulationCore } from '../src/layout/forces';

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

describe('Settings & security sanitization', () => {
  it('prevents prototype pollution and unknown keys in applyNativeOptions and mergeData', () => {
    const target = cloneGraphOptions(DEFAULT_GRAPH_OPTIONS);
    const malicious = JSON.parse(
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
    assert.equal(merged.takeover, true);
    assert.equal(merged.cluster.threshold, DEFAULT_CLUSTER_OPTIONS.threshold);
  });

  it('clamps cluster options and color groups safely', () => {
    const cluster = sanitizeClusterOptions({
      threshold: -5,
      maxVisibleNodes: 999999,
      maxMetadataNodes: -10,
      mode: 'invalid' as 'direct',
    });
    assert.equal(cluster.threshold, 1);
    assert.equal(cluster.maxVisibleNodes, 100000);
    assert.equal(cluster.maxMetadataNodes, 0);
    assert.equal(cluster.mode, 'direct');

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

describe('RawGraph indexing & query engine', () => {
  it('indexes unresolved links with Object.prototype names and deduplicates per-file tags', () => {
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

  it('guards against deeply nested queries and trailing OR operators', () => {
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

describe('Graph builder & folder clustering', () => {
  it('collapses large folders into cluster nodes and supports progressive reveal', () => {
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
});

describe('Physics simulation & spatial hash stability', () => {
  it('handles 200 coincident nodes and oversized cluster radii without infinite loops or NaN', () => {
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
});
