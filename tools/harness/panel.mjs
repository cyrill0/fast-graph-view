// Control panel scenario: every click, drag, keystroke and slider nudge below goes through
// CDP Input, so the panel is driven exactly as a user drives it. Assertions read the live
// GraphOptions object and the model the engine rebuilt, not just the DOM.
//
// The panel floats above the canvas, so aiming is by element rect rather than node position.

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
  const leaf = () => app.workspace.getLeavesOfType('graph')[0] ?? null;
  window.__p = {
    leaf,
    view: () => leaf()?.view ?? null,
    presenter: () => leaf()?.view?.presenter ?? null,
    engine: () => leaf()?.view?.presenter?.engine ?? null,
    options: () => leaf()?.view?.presenter?.options ?? null,
    panel: () => leaf()?.view?.contentEl.querySelector('.graph-controls'),
  };
  window.__pWait = async (budget) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    let frames = 0;
    let stop = false;
    const tick = () => { frames++; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    while (Date.now() - t0 < budget) {
      const e = window.__p.engine();
      if (e && !e.running && e.alpha <= 0.001 && !e.timelapsing) break;
      await sleep(250);
    }
    stop = true;
    const e = window.__p.engine();
    return JSON.stringify({
      idle: !!(e && !e.running && e.alpha <= 0.001),
      waited: Date.now() - t0,
      frames,
      running: e?.running ?? null,
      alpha: e?.alpha ?? null,
    });
  };
  return 1;
})()`;

const SNAPSHOT = `JSON.stringify((function () {
  const o = window.__p.options();
  const m = window.__p.engine()?.model;
  let tags = 0, clusters = 0, files = 0, unresolved = 0, attachments = 0;
  if (m) for (let i = 0; i < m.nodeCount; i++) {
    const k = m.kind[i];
    if (k === 0) files++;
    else if (k === 1) attachments++;
    else if (k === 2) tags++;
    else if (k === 3) unresolved++;
    else if (k === 4) clusters++;
  }
  return {
    search: o.search,
    showTags: o.showTags,
    showAttachments: o.showAttachments,
    hideUnresolved: o.hideUnresolved,
    showOrphans: o.showOrphans,
    showArrow: o.showArrow,
    nodeSize: o.nodeSizeMultiplier,
    lineSize: o.lineSizeMultiplier,
    textFade: o.textFadeMultiplier,
    repel: o.repelStrength,
    linkDist: o.linkDistance,
    linkStrength: o.linkStrength,
    centerStrength: Math.round(o.centerStrength * 1000) / 1000,
    groups: o.colorGroups.length,
    close: o.close,
    collapsed: [o['collapse-filter'], o['collapse-color-groups'], o['collapse-display'], o['collapse-forces']],
    nodes: m?.nodeCount ?? null,
    edges: m?.edgeCount ?? null,
    files, tags, clusters, unresolved, attachments,
    collapsedFiles: m?.stats?.collapsedFiles ?? null,
  };
})())`;

export default async function ({ evalJs, mouse, key, type, shot, sleep }) {
  const out = {};
  const step = async (name, fn) => {
    try {
      out[name] = await fn();
      console.error(`[panel] ${name} ${String(JSON.stringify(out[name])).slice(0, 320)}`);
    } catch (e) {
      out[name] = { failed: String(e.message ?? e) };
      console.error(`[panel] ${name} FAILED ${e.message}`);
    }
    return out[name];
  };
  const json = (s) => (s ? JSON.parse(s) : null);
  const snapshot = () => evalJs(SNAPSHOT).then(json);
  const waitIdle = (budget = 30000) => evalJs(`window.__pWait(${budget})`).then(json);

  /** centre of a plain element, by selector */
  const rect = async (selector) =>
    json(
      await evalJs(`(function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) });
      })()`),
    );

  /** centre of the control inside the panel row whose setting name contains `text` */
  const named = async (what, text) =>
    json(
      await evalJs(`(function () {
        const panel = window.__p.panel();
        if (!panel) return null;
        const rows = [...panel.querySelectorAll('.setting-item')].filter((r) =>
          (r.querySelector('.setting-item-name')?.textContent ?? '').toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
        const el = rows[0]?.querySelector(${JSON.stringify(
          what === 'toggle' ? '.checkbox-container' : what === 'slider' ? 'input[type=range]' : 'input',
        )});
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), label: rows[0].querySelector('.setting-item-name').textContent, rows: rows.length });
      })()`),
    );

  const clickAt = async (at, waitMs = 700) => {
    if (!at) return { skipped: 'element not found' };
    await mouse('move', at.x, at.y, { waitMs: 120 });
    await mouse('click', at.x, at.y, { waitMs });
    return { x: at.x, y: at.y, label: at.label };
  };
  const clickSel = async (selector, waitMs = 700) => clickAt(await rect(selector), waitMs);

  await step('frameSource', () => evalJs(FRAME_SOURCE));
  await step('context', () => evalJs(`${CONTEXT}; 1`));
  await step('beforeIdle', () => waitIdle(60000));
  out.baseline = await step('optionsBefore', () => snapshot());

  await step('panelChrome', () =>
    evalJs(`JSON.stringify((function () {
      const panel = window.__p.panel();
      return {
        exists: !!panel,
        closed: panel ? panel.hasClass('is-close') : null,
        ignoreSwipe: panel?.dataset?.ignoreSwipe ?? null,
        buttons: [...(panel?.querySelectorAll('.graph-controls-button') ?? [])].map((b) => [...b.classList].find((c) => c.startsWith('mod-'))),
        sections: [...(panel?.querySelectorAll('.graph-control-section') ?? [])].map((s) => [...s.classList].find((c) => c.startsWith('mod-'))),
        collapsedIcons: [...(panel?.querySelectorAll('.graph-control-section .collapse-icon') ?? [])].map((i) => i.hasClass('is-collapsed')),
      };
    })())`),
  );

  await step('panelClose', async () => {
    const at = await clickSel('.graph-controls .mod-close', 500);
    return { at, closed: await evalJs(`window.__p.panel().hasClass('is-close')`), option: await evalJs(`window.__p.options().close`) };
  });
  await step('panelOpen', async () => {
    const at = await clickSel('.graph-controls .mod-open', 500);
    return { at, closed: await evalJs(`window.__p.panel().hasClass('is-close')`), option: await evalJs(`window.__p.options().close`) };
  });
  await step('shotPanel', () => shot('/tmp/shots/panel-open.png'));

  // each section header collapses the body and stores the flag in the options
  const collapseKey = { filter: 'collapse-filter', 'color-groups': 'collapse-color-groups', display: 'collapse-display', forces: 'collapse-forces' };
  for (const s of Object.keys(collapseKey)) {
    await step(`collapse_${s}`, async () => {
      const sel = `.graph-controls .mod-${s} .tree-item-self`;
      const at = await clickSel(sel, 500);
      if (at?.skipped) return at;
      const read = () =>
        evalJs(`JSON.stringify({ icon: document.querySelector('.graph-controls .mod-${s} .collapse-icon').hasClass('is-collapsed'), option: window.__p.options()['${collapseKey[s]}'], bodyHeight: Math.round(document.querySelector('.graph-controls .mod-${s} .tree-item-children').getBoundingClientRect().height) })`).then(json);
      const after = await read();
      const at2 = await clickSel(sel, 500);
      return { at, after, restored: await read(), at2 };
    });
  }

  // filter toggles rebuild the model, so node counts must follow the option
  for (const [label, keyName] of [['tags', 'showTags'], ['attachments', 'showAttachments'], ['orphans', 'showOrphans']]) {
    await step(`toggle_${keyName}`, async () => {
      const at = await named('toggle', label);
      if (!at) return { skipped: `no toggle matching "${label}"` };
      const v0 = await evalJs(`window.__p.options().${keyName}`);
      const n0 = await snapshot();
      await clickAt(at, 900);
      const v1 = await evalJs(`window.__p.options().${keyName}`);
      const settled = await waitIdle(45000);
      const n1 = await snapshot();
      await clickAt(at, 900);
      const v2 = await evalJs(`window.__p.options().${keyName}`);
      await waitIdle(45000);
      return {
        label: at.label,
        rows: at.rows,
        before: v0,
        after: v1,
        restored: v2,
        nodesBefore: n0.nodes,
        nodesAfter: n1.nodes,
        delta: { files: n1.files - n0.files, tags: n1.tags - n0.tags, attachments: n1.attachments - n0.attachments, unresolved: n1.unresolved - n0.unresolved, clusters: n1.clusters - n0.clusters },
        settled,
      };
    });
  }

  // search: real typing into the panel field, Enter commits
  await step('search', async () => {
    const at = await named('input', '');
    if (!at) return { skipped: 'no search input' };
    await clickAt(at, 300);
    await type('path:ETH');
    const typed = await evalJs(`window.__p.options().search`);
    await key('Enter', { waitMs: 1000 });
    const settled = await waitIdle(45000);
    const filtered = await snapshot();
    const status = await evalJs(`window.__p.view().contentEl.querySelector('.fast-graph-status')?.textContent ?? null`);
    await shot('/tmp/shots/panel-search.png');
    const cleared = await clickSel('.graph-controls .mod-filter .input-clear-button', 500);
    await key('Enter', { waitMs: 900 });
    await waitIdle(45000);
    const restored = await snapshot();
    return {
      label: at.label,
      typed,
      settled,
      filtered: { nodes: filtered.nodes, files: filtered.files, clusters: filtered.clusters, tags: filtered.tags, edges: filtered.edges },
      status,
      cleared,
      restoredSearch: restored.search,
      restoredNodes: restored.nodes,
    };
  });

  // colour groups: add two by button, type queries, then reorder by dragging a row
  await step('addGroups', async () => {
    await clickSel('.graph-controls .graph-color-button-container .clickable-icon', 700);
    const rows1 = await evalJs(`document.querySelectorAll('.graph-controls .graph-color-group').length`);
    await clickSel('.graph-controls .graph-color-button-container .clickable-icon', 700);
    const rows2 = await evalJs(`document.querySelectorAll('.graph-controls .graph-color-group').length`);
    const first = await rect('.graph-controls .graph-color-group:nth-child(1) input');
    const second = await rect('.graph-controls .graph-color-group:nth-child(2) input');
    if (!first || !second) return { rows1, rows2, skipped: 'group row inputs not found' };
    await clickAt(first, 250);
    await type('path:ETH');
    await key('Enter', { waitMs: 700 });
    await clickAt(second, 250);
    await type('is:tag');
    await key('Enter', { waitMs: 700 });
    const groups = evalJs(`JSON.stringify(window.__p.options().colorGroups.map((g) => ({ query: g.query, rgb: g.color.rgb })))`).then(json);
    const settled = await waitIdle(45000);
    const coloured = await evalJs(`(function () { const e = window.__p.engine(); const keys = Object.keys(e).filter((k) => /col|hue|tint/i.test(k)); return JSON.stringify({ keys, coloredNodes: e.colored ? e.colored.length ?? e.colored : null }); })()`).then(json);
    return { rows1, rows2, groups: await groups, settled, coloured };
  });

  await step('dragGroupRow', async () => {
    const row = await rect('.graph-controls .graph-color-group:nth-child(1)');
    const to = await rect('.graph-controls .graph-color-group:nth-child(2)');
    if (!row || !to) return { skipped: 'need two rows' };
    const order0 = evalJs(`JSON.stringify(window.__p.options().colorGroups.map((g) => g.query))`).then(json);
    // the row is dragged by its name field, like the native group list
    const grab = { x: row.x - 60, y: row.y };
    await mouse('down', grab.x, grab.y, { waitMs: 150 });
    const during = await evalJs(`JSON.stringify({ body: document.body.hasClass('is-grabbing'), ghosts: document.querySelectorAll('.drag-ghost').length, rowGrabbing: document.querySelectorAll('.graph-color-group.is-grabbing').length })`).then(json);
    for (let i = 1; i <= 6; i++) await mouse('move', grab.x + i * 12, grab.y + i * 14, { held: 'left', waitMs: 40 });
    await mouse('up', to.x - 60, to.y, { waitMs: 800 });
    const order1 = evalJs(`JSON.stringify(window.__p.options().colorGroups.map((g) => g.query))`).then(json);
    return {
      grab,
      during,
      bodyGrabbingAfter: await evalJs(`document.body.hasClass('is-grabbing')`),
      ghostsAfter: await evalJs(`document.querySelectorAll('.drag-ghost').length`),
      orderBefore: await order0,
      orderAfter: await order1,
    };
  });

  await step('removeGroups', async () => {
    let n = await evalJs(`document.querySelectorAll('.graph-controls .graph-color-group').length`);
    let clicks = 0;
    while (n > 0 && clicks < 6) {
      const at = await rect('.graph-controls .graph-color-group:nth-child(1) .clickable-icon');
      if (!at) break;
      await clickAt(at, 500);
      clicks++;
      n = await evalJs(`document.querySelectorAll('.graph-controls .graph-color-group').length`);
    }
    return { clicks, rowsLeft: n, optionLength: await evalJs(`window.__p.options().colorGroups.length`) };
  });

  // sliders: arrow keys on a focused range input are the native keyboard interaction
  await step('sliderKeys', async () => {
    const at = await named('slider', 'node size');
    if (!at) return { skipped: 'no node size slider' };
    const v0 = await evalJs(`window.__p.options().nodeSizeMultiplier`);
    await clickAt(at, 300);
    for (let i = 0; i < 5; i++) await key('ArrowRight', { waitMs: 120 });
    const v1 = await evalJs(`window.__p.options().nodeSizeMultiplier`);
    const domValue = await evalJs(`(function () { const el = document.querySelector('.graph-controls .mod-display input[type=range]'); return el ? Number(el.value) : null; })()`);
    await clickAt(at, 200);
    for (let i = 0; i < 5; i++) await key('ArrowLeft', { waitMs: 120 });
    const v2 = await evalJs(`window.__p.options().nodeSizeMultiplier`);
    return { label: at.label, before: v0, afterRight: v1, domValue, afterLeft: v2 };
  });

  // timelapse: the animate button starts it, Escape stops it
  await step('timelapse', async () => {
    const at = await clickSel('.graph-controls .mod-animate', 1200);
    if (at?.skipped) return at;
    const started = evalJs(`JSON.stringify({ timelapsing: window.__p.engine().timelapsing, nodes: window.__p.engine().model.nodeCount, status: window.__p.view().contentEl.querySelector('.fast-graph-status')?.textContent ?? null })`).then(json);
    await sleep(4000);
    const later = evalJs(`JSON.stringify({ timelapsing: window.__p.engine().timelapsing, nodes: window.__p.engine().model.nodeCount, alpha: Math.round(window.__p.engine().alpha * 1000) / 1000 })`).then(json);
    await key('Escape', { waitMs: 800 });
    const stopped = evalJs(`JSON.stringify({ timelapsing: window.__p.engine().timelapsing, nodes: window.__p.engine().model.nodeCount })`).then(json);
    await waitIdle(45000);
    return { at, started: await started, later: await later, afterEscape: await stopped };
  });

  await step('restoreDefaults', async () => {
    const at = await clickSel('.graph-controls .mod-reset', 1200);
    const settled = await waitIdle(60000);
    return { at, settled, after: await snapshot() };
  });

  await step('errors', () => evalJs(`(window.__errs ?? []).slice(-8)`));
  await step('status', () => evalJs(`window.__p.view().contentEl.querySelector('.fast-graph-status')?.textContent ?? null`));
  return out;
}
