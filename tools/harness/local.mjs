// Local graph scenario: the takeover registers our view under the core `localgraph` type,
// so everything a user reaches for - "Open local graph" from the file menu, the ribbon, the
// command palette - has to land on our view and keep the native behaviours: the root follows
// the active note unless the leaf is pinned, jumps/backlinks/forelinks/interlinks shape the
// neighbourhood, and per-leaf options are stored in the leaf state.

const FRAME_SOURCE = `(async () => {
  const windows = [];
  for (let w = 0; w < 2; w++) {
    let n = 0;
    const t0 = performance.now();
    requestAnimationFrame(function loop() { n++; if (performance.now() - t0 < 500) requestAnimationFrame(loop); });
    await new Promise((r) => setTimeout(r, 650));
    windows.push(n);
  }
  return JSON.stringify({ framesPer500ms: windows, visibility: document.visibilityState });
})()`;

const CONTEXT = `(() => {
  const app = window.app;
  const leaves = () => app.workspace.getLeavesOfType('localgraph');
  window.__l = {
    leaves,
    leaf: () => leaves()[0] ?? null,
    view: () => leaves()[0]?.view ?? null,
    engine: () => leaves()[0]?.view?.presenter?.engine ?? null,
    options: () => leaves()[0]?.view?.presenter?.options ?? null,
  };
  window.__lWait = async (budget) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    let frames = 0;
    let stop = false;
    const tick = () => { frames++; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    while (Date.now() - t0 < budget) {
      const e = window.__l.engine();
      if (e && !e.running && e.alpha <= 0.001) break;
      await sleep(200);
    }
    stop = true;
    const e = window.__l.engine();
    return JSON.stringify({ idle: !!(e && !e.running && e.alpha <= 0.001), waited: Date.now() - t0, frames, running: e?.running ?? null });
  };
  return 1;
})()`;

const STATE = `JSON.stringify((function () {
  const view = window.__l.view();
  const e = window.__l.engine();
  const o = window.__l.options();
  const m = e?.model;
  let clusters = 0, files = 0, tags = 0, unresolved = 0, attachments = 0;
  if (m) for (let i = 0; i < m.nodeCount; i++) {
    const k = m.kind[i];
    if (k === 0) files++; else if (k === 1) attachments++; else if (k === 2) tags++; else if (k === 3) unresolved++; else if (k === 4) clusters++;
  }
  const leaf = window.__l.leaf();
  return {
    viewType: view?.getViewType?.() ?? null,
    hasCanvas: !!view?.contentEl?.querySelector('.fast-graph-gl'),
    root: e?.scopePath ?? null,
    activeFile: window.app.workspace.getActiveFile()?.path ?? null,
    leafPinned: !!leaf?.pinned,
    isLocal: !!view?.presenter?.isLocal,
    jumps: o?.localJumps ?? null,
    backlinks: o?.localBacklinks ?? null,
    forelinks: o?.localForelinks ?? null,
    interlinks: o?.localInterlinks ?? null,
    hoverSource: window.app.plugins.getPlugin('fast-graph-view')?.hoverSource ?? null,
    nodes: m?.nodeCount ?? null, edges: m?.edgeCount ?? null,
    counts: { files, clusters, tags, unresolved, attachments },
    status: view?.contentEl?.querySelector('.fast-graph-status')?.textContent ?? null,
  };
})())`;

export default async function ({ evalJs, mouse, key, type, sleep, shot }) {
  const out = {};
  const step = async (name, fn) => {
    try {
      out[name] = await fn();
      console.error(`[local] ${name} ${String(JSON.stringify(out[name])).slice(0, 320)}`);
    } catch (e) {
      out[name] = { failed: String(e.message ?? e) };
      console.error(`[local] ${name} FAILED ${e.message}`);
    }
    return out[name];
  };
  const json = (s) => (s ? JSON.parse(s) : null);
  const waitIdle = (b = 30000) => evalJs(`window.__lWait(${b})`).then(json);

  await step('frameSource', () => evalJs(FRAME_SOURCE));
  await step('context', () => evalJs(`${CONTEXT}; 1`));

  // a note deep inside an over-threshold folder, so the local view has a cluster to fold
  const picked = json(
    await evalJs(`(function () {
      const app = window.app;
      const all = app.vault.getMarkdownFiles();
      let deep = null, big = null;
      for (const f of all) {
        if (!big && f.basename === 'CLAUDE') big = f.path;
        if (!deep && f.path.startsWith('ETH/Concepts/003/') && f.stat.size > 400) deep = f.path;
        if (big && deep) break;
      }
      return JSON.stringify({ big, deep, total: all.length });
    })()`),
  );
  out.target = picked;

  await step('openNote', async () => {
    await evalJs(`window.app.workspace.openLinkText(${JSON.stringify(picked.deep ?? picked.big)}, '', false)`);
    for (let i = 0; i < 40; i++) {
      const p = await evalJs(`window.app.workspace.getActiveFile()?.path ?? null`);
      if (p === (picked.deep ?? picked.big)) break;
      await sleep(250);
    }
    return { active: await evalJs(`window.app.workspace.getActiveFile()?.path ?? null`) };
  });

  await step('openLocalGraph', async () => {
    const ran = await evalJs(`window.app.commands.executeCommandById('graph:open-local')`);
    for (let i = 0; i < 60; i++) {
      const ready = await evalJs(`!!window.__l.engine()?.model`);
      if (ready) break;
      await sleep(250);
    }
    return { commandReturned: ran, state: json(await evalJs(STATE)) };
  });
  await step('localIdle', () => waitIdle(45000));
  await step('shotLocal', () => shot('/tmp/shots/local-graph.png'));

  // the root follows the active note while the leaf is unpinned
  await step('followsActiveFile', async () => {
    const root0 = await evalJs(`window.__l.engine()?.scopePath ?? null`);
    await evalJs(`window.app.workspace.openLinkText(${JSON.stringify(picked.big)}, '', false)`);
    await sleep(1500);
    const st = json(await evalJs(STATE));
    await waitIdle(30000);
    const moved = st.root !== root0;
    // back to the deep note for the rest of the run
    await evalJs(`window.app.workspace.openLinkText(${JSON.stringify(picked.deep ?? picked.big)}, '', false)`);
    await sleep(1500);
    await waitIdle(30000);
    return { root0, afterSwitch: st.root, followed: moved, activeNow: json(await evalJs(STATE)).root ?? null };
  });

  // pinning freezes the root
  await step('pinnedKeepsRoot', async () => {
    await evalJs(`window.__l.leaf().setPinned(true)`);
    const root0 = await evalJs(`window.__l.engine()?.scopePath ?? null`);
    await evalJs(`window.app.workspace.openLinkText(${JSON.stringify(picked.big)}, '', false)`);
    await sleep(1500);
    const root1 = await evalJs(`window.__l.engine()?.scopePath ?? null`);
    await evalJs(`window.__l.leaf().setPinned(false)`);
    await sleep(1500);
    const root2 = await evalJs(`window.__l.engine()?.scopePath ?? null`);
    return { pinned: await evalJs(`!!window.__l.leaf()?.pinned`), rootWhilePinned: [root0, root1], afterUnpin: root2 };
  });

  // link direction options reshape the neighbourhood
  for (const keyName of ['localBacklinks', 'localForelinks', 'localInterlinks']) {
    await step(`option_${keyName}`, async () => {
      const v0 = await evalJs(`window.__l.options().${keyName}`);
      const n0 = await evalJs(`window.__l.engine().model.nodeCount`);
      await evalJs(`(function () {
        const o = window.__l.options();
        o.${keyName} = !o.${keyName};
        window.__l.view().presenter.onOptionsChange();
      })()`);
      await waitIdle(30000);
      const n1 = await evalJs(`window.__l.engine().model.nodeCount`);
      await evalJs(`(function () {
        const o = window.__l.options();
        o.${keyName} = !o.${keyName};
        window.__l.view().presenter.onOptionsChange();
      })()`);
      await waitIdle(30000);
      return { before: v0, nodesBefore: n0, nodesAfter: n1, restored: await evalJs(`window.__l.options().${keyName}`), nodesRestored: await evalJs(`window.__l.engine().model.nodeCount`) };
    });
  }

  // jump depth through the panel slider, focused by a real click
  await step('depthSlider', async () => {
    const at = json(
      await evalJs(`(function () {
        const panel = window.__l.view().contentEl.querySelector('.graph-controls');
        if (!panel || panel.hasClass('is-close')) return null;
        const rows = [...panel.querySelectorAll('.setting-item')].filter((r) =>
          (r.querySelector('.setting-item-name')?.textContent ?? '').toLowerCase().includes('depth'));
        const el = rows[0]?.querySelector('input[type=range]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), label: rows[0].querySelector('.setting-item-name').textContent });
      })()`),
    );
    if (!at) return { skipped: 'no depth slider (panel closed or section collapsed)' };
    const j0 = await evalJs(`window.__l.options().localJumps`);
    const n0 = await evalJs(`window.__l.engine().model.nodeCount`);
    await mouse('move', at.x, at.y, { waitMs: 120 });
    await mouse('click', at.x, at.y, { waitMs: 300 });
    for (let i = 0; i < 4; i++) await key('ArrowRight', { waitMs: 150 });
    const j1 = await evalJs(`window.__l.options().localJumps`);
    await waitIdle(45000);
    const n1 = await evalJs(`window.__l.engine().model.nodeCount`);
    return { label: at.label, jumps: [j0, j1], nodes: [n0, n1] };
  });

  // hovering a folded cluster inside the local graph shows the same metadata card
  await step('localClusterHover', async () => {
    const at = json(
      await evalJs(`(function () {
        const e = window.__l.engine();
        const cv = window.__l.view().contentEl.querySelector('.fast-graph-gl');
        const b = cv.getBoundingClientRect();
        for (let i = 0; i < e.model.nodeCount; i++) {
          if (e.model.kind[i] !== 4) continue;
          const x = Math.round(e.camera.worldToScreenX(e.pos[i * 2]));
          const y = Math.round(e.camera.worldToScreenY(e.pos[i * 2 + 1]));
          if (x < 20 || y < 20 || x > b.width - 20 || y > b.height - 20) continue;
          if (e.hitTest(x, y) !== i) continue;
          if (document.elementFromPoint(b.left + x, b.top + y) !== cv) continue;
          return JSON.stringify({ i, x: Math.round(b.left + x), y: Math.round(b.top + y), folder: e.model.path[i] });
        }
        return null;
      })()`),
    );
    if (!at) return { skipped: 'no hittable cluster in this local graph' };
    await mouse('move', at.x - 40, at.y - 40, { waitMs: 200 });
    await mouse('move', at.x, at.y, { waitMs: 1200 });
    const card = await evalJs(`window.__l.view().contentEl.querySelector('.fast-graph-card')?.innerText?.replace(/\\n+/g, ' ') ?? null`);
    await shot('/tmp/shots/local-cluster-hover.png');
    return { at, card: card?.slice(0, 160) ?? null };
  });

  // leaf state round-trip: close and reopen the same local graph from its saved state
  await step('stateRoundTrip', async () => {
    const state = json(await evalJs(`JSON.stringify(window.__l.leaf().getViewState())`));
    const before = await evalJs(`window.__l.engine()?.scopePath ?? null`);
    await evalJs(`window.__l.leaf().setViewState({ type: 'localgraph', active: true, state: { file: ${JSON.stringify(picked.big)} } })`);
    await sleep(1200);
    await waitIdle(30000);
    const after = json(await evalJs(STATE));
    return { savedType: state?.type, savedFile: state?.state?.file ?? null, rootBefore: before, rootAfter: after.root, nodes: after.nodes, canvas: after.hasCanvas };
  });

  // teardown: closing the leaf must leave no orphan canvas behind and must not hurt the global view
  await step('closeAndLeakCheck', async () => {
    const canvases0 = await evalJs(`document.querySelectorAll('.fast-graph-gl').length`);
    await evalJs(`window.__l.leaf().setViewState({ type: 'empty', active: false })`);
    await sleep(800);
    return {
      canvasesBefore: canvases0,
      canvasesAfter: await evalJs(`document.querySelectorAll('.fast-graph-gl').length`),
      localLeaves: await evalJs(`window.app.workspace.getLeavesOfType('localgraph').length`),
      globalGraphStillWorks: json(
        await evalJs(`JSON.stringify({ graphLeaves: window.app.workspace.getLeavesOfType('graph').length, nodes: window.app.workspace.getLeavesOfType('graph')[0]?.view?.presenter?.engine?.model?.nodeCount ?? null })`),
      ),
    };
  });

  await step('errors', () => evalJs(`(window.__errs ?? []).slice(-8)`));
  return out;
}
