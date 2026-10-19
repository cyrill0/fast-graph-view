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
  if (!window.__errs) {
    window.__errs = [];
    addEventListener('error', (ev) => window.__errs.push('error: ' + ev.message + ' @' + ev.filename + ':' + ev.lineno));
    addEventListener('unhandledrejection', (ev) => window.__errs.push('reject: ' + String(ev.reason).slice(0, 200)));
    const orig = console.error.bind(console);
    console.error = (...a) => { window.__errs.push('console: ' + a.map(String).join(' ').slice(0, 200)); orig(...a); };
  }
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

export default async function ({ evalJs, mouse, key, type, sleep, shot, wake, raise }) {
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
  const starved = (r) => !!r && (r.frames ?? 0) * 100 < (r.waited ?? 0);

  /** An occluded Electron window stops producing BeginFrames while still reporting `visible`. */
  const nudge = async () => {
    await wake();
    await raise();
    await shot('/tmp/shots/local-nudge.png');
    await sleep(600);
  };
  const settle = async (budget = 30000, retries = 3) => {
    const r = await waitIdle(budget);
    if (starved(r) && retries > 0) {
      await nudge();
      const again = await settle(budget, retries - 1);
      return { ...again, nudges: 1 + (r.nudges ?? 0) };
    }
    return { ...r, starved: starved(r) };
  };
  const cadence = (ms = 1500) =>
    evalJs(`(async () => {
      const t0 = performance.now();
      let n = 0;
      await new Promise((r) => { setTimeout(r, ${ms}); requestAnimationFrame(function loop() { n++; if (performance.now() - t0 < ${ms}) requestAnimationFrame(loop); else r(); }); });
      return JSON.stringify({ frames: n, ms: Math.round(performance.now() - t0), fps: Math.round((n / (performance.now() - t0)) * 1000 * 10) / 10, vis: document.visibilityState, focus: document.hasFocus() });
    })()`).then(json);

  /** Open a control section so its rows have real rects; collapsed bodies are display:none. */
  const ensureOpen = async (key) => {
    for (let i = 0; i < 3; i++) {
      const st = json(
        await evalJs(`(function () {
          const s = window.__l.view()?.contentEl.querySelector('.graph-controls .mod-${key}');
          if (!s) return null;
          return JSON.stringify({ collapsed: s.hasClass('is-collapsed'), bodyHeight: Math.round(s.querySelector('.tree-item-children').getBoundingClientRect().height) });
        })()`),
      );
      if (st && st.bodyHeight > 10) return st;
      const at = json(
        await evalJs(`(function () {
          const el = window.__l.view()?.contentEl.querySelector('.graph-controls .mod-${key} .tree-item-self');
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
        })()`),
      );
      if (!at) return { skipped: 'section not found' };
      await mouse('move', at.x, at.y, { waitMs: 100 });
      await mouse('click', at.x, at.y, { waitMs: 400 });
    }
    return json(await evalJs(`JSON.stringify({ bodyHeight: Math.round(window.__l.view().contentEl.querySelector('.graph-controls .mod-${key} .tree-item-children').getBoundingClientRect().height) })`));
  };

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
    // panes left over from earlier runs make every later count ambiguous
    const stale = json(await evalJs(`(async () => {
      const app = window.app;
      const n = ['localgraph', 'fast-localgraph'].reduce((a, t) => a + app.workspace.getLeavesOfType(t).length, 0);
      for (const t of ['localgraph', 'fast-localgraph']) app.workspace.detachLeavesOfType(t);
      await new Promise((r) => setTimeout(r, 700));
      return JSON.stringify({ detached: n, left: ['localgraph', 'fast-localgraph'].reduce((a, t) => a + app.workspace.getLeavesOfType(t).length, 0) });
    })()`));
    const ran = await evalJs(`window.app.commands.executeCommandById('graph:open-local')`);
    for (let i = 0; i < 60; i++) {
      const ready = await evalJs(`!!window.__l.engine()?.model`);
      if (ready) break;
      await sleep(250);
    }
    return { stale, commandReturned: ran, state: json(await evalJs(STATE)) };
  });
  await step('localIdle', () => settle(45000));
  await step('shotLocal', () => shot('/tmp/shots/local-graph.png'));

  // the root follows the active note while the leaf is unpinned
  await step('followsActiveFile', async () => {
    const root0 = await evalJs(`window.__l.engine()?.scopePath ?? null`);
    await evalJs(`window.app.workspace.openLinkText(${JSON.stringify(picked.big)}, '', false)`);
    await sleep(1500);
    const st = json(await evalJs(STATE));
    await settle(30000);
    const moved = st.root !== root0;
    // back to the deep note for the rest of the run
    await evalJs(`window.app.workspace.openLinkText(${JSON.stringify(picked.deep ?? picked.big)}, '', false)`);
    await sleep(1500);
    await settle(30000);
    return { root0, afterSwitch: st.root, followed: moved, activeNow: json(await evalJs(STATE)).root ?? null };
  });

  // pinning freezes the root
  await step('pinnedKeepsRoot', async () => {
    // measured on a dedicated ungrouped pane: a grouped local graph follows its group's file,
    // and panes left over from earlier steps make the freeze/resume verdict ambiguous
    const files = json(await evalJs(`JSON.stringify(window.app.vault.getMarkdownFiles().filter((f) => f.extension === 'md').map((f) => f.path).slice(0, 40))`));
    const other = files.find((p) => p !== picked.big && p !== picked.deep) ?? null;
    const setup = json(await evalJs(`(async () => {
      const app = window.app;
      for (const t of ['localgraph', 'fast-localgraph']) app.workspace.detachLeavesOfType(t);
      await new Promise((r) => setTimeout(r, 700));
      const note = await app.workspace.getLeaf(true);
      await note.setViewState({ type: 'markdown', active: true, state: { file: ${JSON.stringify(picked.deep ?? picked.big)} } });
      await new Promise((r) => setTimeout(r, 1200));
      const g = await app.workspace.getLeaf(true);
      await g.setViewState({ type: 'localgraph', active: false, state: { file: ${JSON.stringify(picked.deep ?? picked.big)} } });
      for (let i = 0; i < 60; i++) {
        if (g.view?.presenter?.engine?.model) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const leaf = app.workspace.getLeavesOfType('localgraph')[0] ?? null;
      return JSON.stringify({ panes: app.workspace.getLeavesOfType('localgraph').length, group: leaf?.group ?? null, root: leaf?.view?.presenter?.engine?.scopePath ?? null });
    })()`));
    const state = async () =>
      json(
        await evalJs(`JSON.stringify((function () {
          const l = window.__l.leaf();
          return { root: l?.view?.presenter?.engine?.scopePath ?? null, viewFile: l?.view?.file?.path ?? null, pinned: !!l?.pinned, group: l?.group ?? null, active: window.app.workspace.getActiveFile()?.path ?? null };
        })())`),
      );
    // open the third file in the markdown leaf, so the graph can only move by following;
    // the leaf has to be activated too - getActiveFile() follows the active leaf, and a
    // background tab would keep the old file current
    const openInNote = async (path) => {
      await evalJs(`(async () => {
        let note = null, active = null;
        window.app.workspace.iterateAllLeaves((l) => {
          if (l.view?.getViewType?.() !== 'markdown') return;
          if (!note) note = l;
          if (window.app.workspace.getActiveLeaf?.() === l) active = l;
        });
        const target = active ?? note;
        const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(path)});
        if (!target || !file) return;
        window.app.workspace.setActiveLeaf(target, { focus: false });
        await target.openFile(file);
        await new Promise((r) => setTimeout(r, 2200));
      })()`);
      const s = await state();
      s.switchFailed = s.active !== path;
      return s;
    };
    const start = await state();
    const pinnedNow = await evalJs(`(function () { const l = window.__l.leaf(); if (l) l.setPinned(true); return !!l?.pinned; })()`);
    const whilePinned = await openInNote(other);
    await evalJs(`(function () { const l = window.__l.leaf(); if (l) l.setPinned(false); })()`);
    await sleep(2200);
    const afterUnpin = await state();
    // hand the scenario back the pane it expects, rooted on the deep note
    const restore = await openInNote(picked.deep ?? picked.big);
    return {
      other,
      setup,
      pinnedNow,
      start,
      whilePinned,
      afterUnpin,
      restore,
      // frozen while pinned although the file in the note changed, then back on it when released
      held: whilePinned.root === start.root && whilePinned.active === other,
      resumed: afterUnpin.root === other && !afterUnpin.pinned,
    };
  });

  // link direction options reshape the neighbourhood - driven through the real switches
  const switchAt = async (label) =>
    json(
      await evalJs(`(function () {
        const panel = window.__l.view().contentEl.querySelector('.graph-controls');
        if (!panel || panel.hasClass('is-close')) return null;
        const row = [...panel.querySelectorAll('.setting-item')].find((r) =>
          (r.querySelector('.setting-item-name')?.textContent ?? '').toLowerCase() === ${JSON.stringify(label.toLowerCase())});
        const el = row?.querySelector('.checkbox-container');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        if (b.width < 4 || b.height < 4) return JSON.stringify({ hidden: true, w: Math.round(b.width), h: Math.round(b.height) });
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height), enabled: el.hasClass('is-enabled') });
      })()`),
    );
  const domEnabled = async (label) =>
    evalJs(`(function () {
      const panel = window.__l.view().contentEl.querySelector('.graph-controls');
      const row = [...panel.querySelectorAll('.setting-item')].find((r) =>
        (r.querySelector('.setting-item-name')?.textContent ?? '').toLowerCase() === ${JSON.stringify(label.toLowerCase())});
      return row?.querySelector('.checkbox-container')?.hasClass('is-enabled') ?? null;
    })()`);
  const directionLabels = { localBacklinks: 'Incoming links', localForelinks: 'Outgoing links', localInterlinks: 'Neighbor links' };
  await step('openLocalFilter', () => ensureOpen('filter'));
  for (const keyName of Object.keys(directionLabels)) {
    const label = directionLabels[keyName];
    await step(`option_${keyName}`, async () => {
      const v0 = await evalJs(`window.__l.options().${keyName}`);
      const n0 = await evalJs(`window.__l.engine().model.nodeCount`);
      const at = await switchAt(label);
      let via = 'trusted click';
      if (!at) {
        via = 'programmatic (row not found)';
        await evalJs(`(function () { const o = window.__l.options(); o.${keyName} = !o.${keyName}; window.__l.view().presenter.onOptionsChange(); })()`);
      } else if (at.hidden) {
        return { label, skipped: `switch hidden (rect ${at.w}x${at.h})` };
      } else {
        await mouse('move', at.x, at.y, { waitMs: 120 });
        await mouse('click', at.x, at.y, { waitMs: 500 });
      }
      const v1 = await evalJs(`window.__l.options().${keyName}`);
      const d1 = await domEnabled(label);
      const settled = await settle(30000);
      const n1 = await evalJs(`window.__l.engine().model.nodeCount`);
      const at2 = await switchAt(label);
      if (at2 && !at2.hidden) {
        await mouse('move', at2.x, at2.y, { waitMs: 120 });
        await mouse('click', at2.x, at2.y, { waitMs: 500 });
      } else {
        await evalJs(`(function () { const o = window.__l.options(); o.${keyName} = !o.${keyName}; window.__l.view().presenter.onOptionsChange(); })()`);
      }
      const settled2 = await settle(30000);
      return {
        label,
        via,
        before: v0,
        after: v1,
        domAfter: d1,
        nodesBefore: n0,
        nodesAfter: n1,
        delta: n1 - n0,
        restored: await evalJs(`window.__l.options().${keyName}`),
        domRestored: await domEnabled(label),
        nodesRestored: await evalJs(`window.__l.engine().model.nodeCount`),
        settled,
        settledBack: settled2,
      };
    });
  }

  // jump depth through the panel slider, focused by a real click
  const rectOfDepthSlider = async () =>
    json(
      await evalJs(`(function () {
        const panel = window.__l.view().contentEl.querySelector('.graph-controls');
        if (!panel || panel.hasClass('is-close')) return null;
        const rows = [...panel.querySelectorAll('.setting-item')].filter((r) =>
          (r.querySelector('.setting-item-name')?.textContent ?? '').toLowerCase().includes('depth'));
        const el = rows[0]?.querySelector('input[type=range]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        if (b.width < 4 || b.height < 4) return JSON.stringify({ hidden: true, w: Math.round(b.width), h: Math.round(b.height), label: rows[0].querySelector('.setting-item-name').textContent });
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height), label: rows[0].querySelector('.setting-item-name').textContent });
      })()`),
    );
  await step('depthSlider', async () => {
    const open = await ensureOpen('filter');
    const at = await rectOfDepthSlider();
    if (!at) return { open, skipped: 'no depth slider (panel closed or row absent)' };
    if (at.hidden) return { open, skipped: `depth slider hidden (rect ${at.w}x${at.h})` };
    const j0 = await evalJs(`window.__l.options().localJumps`);
    const n0 = await evalJs(`window.__l.engine().model.nodeCount`);
    await mouse('move', at.x, at.y, { waitMs: 120 });
    await mouse('click', at.x, at.y, { waitMs: 300 });
    let focused = await evalJs(`document.activeElement?.type ?? document.activeElement?.className ?? null`);
    let clicks = 1;
    if (focused !== 'range') {
      // keys only reach the slider if the click actually landed on it - aim again at a fresh rect
      const again = await rectOfDepthSlider();
      if (again && !again.hidden) {
        await mouse('move', again.x, again.y, { waitMs: 120 });
        await mouse('click', again.x, again.y, { waitMs: 300 });
        clicks++;
      }
      focused = await evalJs(`document.activeElement?.type ?? document.activeElement?.className ?? null`);
    }
    if (focused !== 'range') return { open, label: at.label, at, activeEl: focused, clicks, skipped: 'slider never took focus' };
    for (let i = 0; i < 4; i++) await key('ArrowRight', { waitMs: 150 });
    const j1 = await evalJs(`window.__l.options().localJumps`);
    const dom1 = await evalJs(`Number(document.activeElement?.value ?? NaN)`);
    await settle(45000);
    const n1 = await evalJs(`window.__l.engine().model.nodeCount`);
    for (let i = 0; i < 5; i++) await key('ArrowLeft', { waitMs: 120 });
    const j2 = await evalJs(`window.__l.options().localJumps`);
    await settle(45000);
    const n2 = await evalJs(`window.__l.engine().model.nodeCount`);
    return { open, label: at.label, at, activeEl: focused, clicks, jumps: [j0, j1, j2], domValueAtMax: dom1, nodes: [n0, n1, n2] };
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
    await settle(30000);
    const after = json(await evalJs(STATE));
    return { savedType: state?.type, savedFile: state?.state?.file ?? null, rootBefore: before, rootAfter: after.root, nodes: after.nodes, canvas: after.hasCanvas };
  });

  // teardown: closing the leaf must leave no orphan canvas behind and must not hurt the global view
  await step('closeAndLeakCheck', async () => {
    const canvases0 = await evalJs(`document.querySelectorAll('.fast-graph-gl').length`);
    // a global view has to exist before the local one closes, else "still works" checks nothing;
    // getLeaf(false) would reuse the active leaf, which here is the local graph itself
    const globalBefore = json(await evalJs(`(async () => {
      const app = window.app;
      const leaf = app.workspace.getLeaf(true);
      await leaf.setViewState({ type: 'graph', active: false, state: {} });
      for (let i = 0; i < 80; i++) {
        if (app.workspace.getLeavesOfType('graph')[0]?.view?.presenter?.engine?.model) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const l = app.workspace.getLeavesOfType('graph')[0] ?? null;
      return JSON.stringify({ graphLeaves: app.workspace.getLeavesOfType('graph').length, nodes: l?.view?.presenter?.engine?.model?.nodeCount ?? null });
    })()`));
    const local = json(await evalJs(`JSON.stringify((function () {
      const l = window.app.workspace.getLeavesOfType('localgraph')[0] ?? null;
      return JSON.stringify({ found: !!l, ours: !!l?.view?.presenter, pinned: !!l?.pinned });
    })())`));
    await evalJs(`(async () => {
      const l = window.app.workspace.getLeavesOfType('localgraph')[0];
      if (l) await l.setViewState({ type: 'empty', active: false });
      await new Promise((r) => setTimeout(r, 800));
    })()`);
    return {
      canvasesBefore: canvases0,
      canvasesAfter: await evalJs(`document.querySelectorAll('.fast-graph-gl').length`),
      localBefore: local,
      localLeaves: await evalJs(`window.app.workspace.getLeavesOfType('localgraph').length`),
      globalBefore,
      globalGraphStillWorks: json(
        await evalJs(`JSON.stringify({ graphLeaves: window.app.workspace.getLeavesOfType('graph').length, ours: !!window.app.workspace.getLeavesOfType('graph')[0]?.view?.presenter, nodes: window.app.workspace.getLeavesOfType('graph')[0]?.view?.presenter?.engine?.model?.nodeCount ?? null })`),
      ),
      canvasesAfterGlobalDetach: await evalJs(`(async () => {
        window.app.workspace.detachLeavesOfType('graph');
        await new Promise((r) => setTimeout(r, 700));
        return document.querySelectorAll('.fast-graph-gl').length;
      })()`),
    };
  });

  await step('errors', () => evalJs(`(window.__errs ?? []).slice(-8)`));
  await step('finalCadence', () => cadence(2000));
  return out;
}
