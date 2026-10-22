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
  if (!window.__errs) {
    window.__errs = [];
    addEventListener('error', (ev) => window.__errs.push('error: ' + ev.message + ' @' + ev.filename + ':' + ev.lineno));
    addEventListener('unhandledrejection', (ev) => window.__errs.push('reject: ' + String(ev.reason).slice(0, 200)));
    const orig = console.error.bind(console);
    console.error = (...a) => { window.__errs.push('console: ' + a.map(String).join(' ').slice(0, 200)); orig(...a); };
  }
  // a dead sim worker silently downgrades to main-thread physics and only reports one line,
  // so keep the thrown stack: it is the only evidence of where the worker actually died
  if (!window.__werr && window.Worker) {
    window.__werr = [];
    const Native = window.Worker;
    function Wrapped(url, o) {
      const w = new Native(url, o);
      w.addEventListener('error', (ev) => {
        window.__werr.push({ msg: String(ev.message).slice(0, 160), stack: String(ev.error?.stack ?? '(no error object)').slice(0, 900) });
      });
      return w;
    }
    Wrapped.prototype = Native.prototype;
    window.Worker = Wrapped;
  }
  const app = window.app;
  const leaf = () => app.workspace.getLeavesOfType('fast-graph-view')[0] ?? null;
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

export default async function ({ evalJs, mouse, key, type, shot, sleep, wake, raise }) {
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
  const starved = (r) => !!r && (r.frames ?? 0) * 100 < (r.waited ?? 0);

  /**
   * The compositor for an occluded Electron window stops producing BeginFrames while
   * `visibilityState` stays `visible`, so rAF - and with it the layout loop - freezes.
   * Waking the saver, raising the page and capturing one screenshot (which forces a frame)
   * unfreezes it often enough that a starved wait is worth retrying instead of trusting.
   */
  const nudge = async () => {
    await wake();
    await raise();
    await shot('/tmp/shots/nudge.png');
    await sleep(600);
  };
  const settle = async (budget = 45000, retries = 3) => {
    const r = await waitIdle(budget);
    if (starved(r) && retries > 0) {
      await nudge();
      const again = await settle(budget, retries - 1);
      return { ...again, nudges: 1 + (r.nudges ?? 0) };
    }
    return { ...r, starved: starved(r) };
  };

  /** Whether a control section's body is actually laid out (a collapsed body is display:none). */
  const sectionState = async (key) =>
    json(
      await evalJs(`(function () {
        const s = document.querySelector('.graph-controls .mod-${key}');
        if (!s) return null;
        return JSON.stringify({
          collapsed: s.hasClass('is-collapsed'),
          bodyHeight: Math.round(s.querySelector('.tree-item-children').getBoundingClientRect().height),
        });
      })()`),
    );

  /** Open a section so its rows have real rects; a user cannot click a hidden control either. */
  const ensureOpen = async (key) => {
    for (let i = 0; i < 3; i++) {
      const st = await sectionState(key);
      if (st && st.bodyHeight > 10) return st;
      await clickSel(`.graph-controls .mod-${key} .tree-item-self`, 400);
    }
    return await sectionState(key);
  };

  /** centre of a plain element, by selector */
  const rect = async (selector) =>
    json(
      await evalJs(`(function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const b = el.getBoundingClientRect();
        if (b.width < 4 || b.height < 4) return JSON.stringify({ hidden: true, w: Math.round(b.width), h: Math.round(b.height) });
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) });
      })()`),
    );

  /**
   * Centre of the control inside the panel row for a `GraphOptions` key.
   *
   * Found by `data-fgv-option`, not by label text: the labels are translated, so
   * text matching would silently find nothing under a non-English Obsidian and
   * every step below would report "skipped" instead of failing.
   */
  const control = async (what, key) =>
    json(
      await evalJs(`(function () {
        const panel = window.__p.panel();
        if (!panel) return null;
        const row = panel.querySelector(${JSON.stringify(`[data-fgv-option="${key}"]`)})?.closest('.setting-item');
        const el = row?.querySelector(${JSON.stringify(
          what === 'toggle' ? '.checkbox-container' : what === 'slider' ? 'input[type=range]' : 'input',
        )});
        if (!el) return null;
        const label = row.querySelector('.setting-item-name')?.textContent ?? key;
        const b = el.getBoundingClientRect();
        // a hidden row reports a 0x0 rect at the page origin; that is not a clickable target
        if (b.width < 4 || b.height < 4) {
          return JSON.stringify({ hidden: true, label, w: Math.round(b.width), h: Math.round(b.height) });
        }
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height), label, hidden: false });
      })()`),
    );

  const clickAt = async (at, waitMs = 700) => {
    if (!at) return { skipped: 'element not found' };
    if (at.hidden) return { skipped: `row "${at.label}" is hidden (rect ${at.w}x${at.h})` };
    await mouse('move', at.x, at.y, { waitMs: 120 });
    await mouse('click', at.x, at.y, { waitMs });
    return { x: at.x, y: at.y, w: at.w, h: at.h, label: at.label };
  };
  const clickSel = async (selector, waitMs = 700) => clickAt(await rect(selector), waitMs);

  await step('frameSource', () => evalJs(FRAME_SOURCE));
  await step('context', () => evalJs(`${CONTEXT}; 1`));
  // the leaf usually already exists when this attaches, and its worker was built by the
  // unwrapped constructor - reopen so the recorded worker covers the whole run
  await step('freshView', async () => {
    const opened = await evalJs(`(async () => {
      const app = window.app;
      app.workspace.detachLeavesOfType('fast-graph-view');
      await new Promise((r) => setTimeout(r, 500));
      app.commands.executeCommandById('fast-graph-view:open');
      for (let i = 0; i < 80; i++) {
        if (window.__p.engine()?.model) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const e = window.__p.engine();
      return JSON.stringify({ leaves: app.workspace.getLeavesOfType('fast-graph-view').length, nodes: e?.model?.nodeCount ?? null });
    })()`);
    return json(opened);
  });
  const health = async () =>
    json(
      await evalJs(`JSON.stringify((function () {
        const e = window.__p.engine();
        return {
          usingWorker: e?.driver?.usingWorker ?? null,
          workerErrors: window.__werr ?? [],
          status: e?.host?.statusEl?.textContent ?? document.querySelector('.fast-graph-status')?.textContent ?? null,
        };
      })())`),
    );
  await step('beforeIdle', () => settle(60000));
  await step('workerHealth', health);
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
      const stored = async () =>
        json(await evalJs(`(async function () {
          const key = ${JSON.stringify(collapseKey[s])};
          const plugin = window.app.plugins.getPlugin('fast-graph-view');
          const saved = await plugin?.loadData?.();
          return JSON.stringify({ live: plugin?.settings?.graph?.[key] ?? null, saved: saved?.graph?.[key] ?? null });
        })()`));
      const after = await read();
      const storedAfter = await stored();
      const at2 = await clickSel(sel, 500);
      const restored = await read();
      await sleep(600);
      const storedRestored = await stored();
      return { at, after, storedAfter, restored, storedRestored, at2 };
    });
  }

  // filter toggles rebuild the model, so node counts must follow the option
  await step('openFilter', () => ensureOpen('filter'));
  const switchState = async (key) =>
    json(
      await evalJs(`(function () {
        const row = window.__p.panel().querySelector(${JSON.stringify(`[data-fgv-option="${key}"]`)})?.closest('.setting-item');
        const box = row?.querySelector('.checkbox-container');
        return JSON.stringify({ name: row?.querySelector('.setting-item-name')?.textContent ?? null, enabled: box ? box.hasClass('is-enabled') : null, input: box?.querySelector('input')?.checked ?? null });
      })()`),
    );
  for (const keyName of ['showTags', 'showAttachments', 'showOrphans']) {
    await step(`toggle_${keyName}`, async () => {
      const at = await control('toggle', keyName);
      if (!at) return { skipped: `no toggle row for ${keyName}` };
      if (at.hidden) return { skipped: `toggle ${keyName} ("${at.label}") hidden in a collapsed section`, at };
      const v0 = await evalJs(`window.__p.options().${keyName}`);
      const d0 = await switchState(keyName);
      const n0 = await snapshot();
      const click = await clickAt(at, 900);
      const v1 = await evalJs(`window.__p.options().${keyName}`);
      const d1 = await switchState(keyName);
      const settled = await settle(45000);
      const n1 = await snapshot();
      const at2 = await control('toggle', keyName);
      await clickAt(at2, 900);
      const v2 = await evalJs(`window.__p.options().${keyName}`);
      const restored = await settle(45000);
      return {
        label: at.label,
        click,
        before: v0,
        domBefore: d0,
        after: v1,
        domAfter: d1,
        restored: v2,
        nodesBefore: n0.nodes,
        nodesAfter: n1.nodes,
        delta: { files: n1.files - n0.files, tags: n1.tags - n0.tags, attachments: n1.attachments - n0.attachments, unresolved: n1.unresolved - n0.unresolved, clusters: n1.clusters - n0.clusters },
        settled,
        restoredSettle: restored,
      };
    });
  }

  // search: real typing into the panel field, Enter commits
  await step('search', async () => {
    await ensureOpen('filter');
    const searchSel = '.graph-controls .mod-filter .search-input-container input';
    const at = await rect(searchSel);
    if (!at) return { skipped: 'no search input' };
    if (at.hidden) return { skipped: 'search input hidden', at };
    await clickAt(at, 300);
    await type('path:ETH');
    // native debounces the query and only writes it on Enter, so an immediate read is expected to lag
    const beforeCommit = await evalJs(`window.__p.options().search`);
    await key('Enter', { waitMs: 1000 });
    const settled = await settle(45000);
    const committed = await evalJs(`window.__p.options().search`);
    const domValue = await evalJs(`document.querySelector(${JSON.stringify(searchSel)})?.value ?? null`);
    const filtered = await snapshot();
    const status = await evalJs(`window.__p.view().contentEl.querySelector('.fast-graph-status')?.textContent ?? null`);
    await shot('/tmp/shots/panel-search.png');
    const clearSel = '.graph-controls .mod-filter .search-input-container .search-input-clear-button';
    const clearVisible = await evalJs(`(function () { const el = document.querySelector(${JSON.stringify(clearSel)}); if (!el) return null; const b = el.getBoundingClientRect(); return JSON.stringify({ w: Math.round(b.width), h: Math.round(b.height) }); })()`);
    const cleared = await clickSel(clearSel, 500);
    await key('Enter', { waitMs: 900 });
    const restoredSettle = await settle(45000);
    const restored = await snapshot();
    return {
      click: { x: at.x, y: at.y, w: at.w, h: at.h },
      beforeCommit,
      committed,
      domValue,
      settled,
      filtered: { nodes: filtered.nodes, files: filtered.files, clusters: filtered.clusters, tags: filtered.tags, edges: filtered.edges },
      status,
      cleared,
      restoredSearch: restored.search,
      restoredNodes: restored.nodes,
      restoredSettle,
    };
  });

  // colour groups: add two by button, type queries, then reorder by dragging a row
  await step('addGroups', async () => {
    const open = await ensureOpen('color-groups');
    await clickSel('.graph-controls .graph-color-button-container button', 700);
    const rows1 = await evalJs(`document.querySelectorAll('.graph-controls .graph-color-group').length`);
    await clickSel('.graph-controls .graph-color-button-container button', 700);
    const rows2 = await evalJs(`document.querySelectorAll('.graph-controls .graph-color-group').length`);
    const first = await rect('.graph-controls .graph-color-group:nth-child(1) input');
    const second = await rect('.graph-controls .graph-color-group:nth-child(2) input');
    if (!first || !second) return { open, rows1, rows2, skipped: 'group row inputs not found' };
    const c1 = await clickAt(first, 250);
    await type('path:ETH');
    await key('Enter', { waitMs: 700 });
    const c2 = await clickAt(second, 250);
    await type('is:tag');
    await key('Enter', { waitMs: 700 });
    const groups = evalJs(`JSON.stringify(window.__p.options().colorGroups.map((g) => ({ query: g.query, rgb: g.color.rgb })))`).then(json);
    const settled = await settle(45000);
    const coloured = await evalJs(`JSON.stringify((function () {
      const m = window.__p.engine().model;
      let grouped = 0, byGroup = {};
      for (let i = 0; i < m.nodeCount; i++) { const g = m.group[i]; if (g >= 0) { grouped++; byGroup[g] = (byGroup[g] ?? 0) + 1; } }
      return { grouped, byGroup, nodes: m.nodeCount };
    })())`);
    return { open, rows1, rows2, clicks: [c1, c2], groups: await groups, settled, coloured };
  });

  await step('dragGroupRow', async () => {
    const row = await rect('.graph-controls .graph-color-group:nth-child(1) input[type=color]');
    const to = await rect('.graph-controls .graph-color-group:nth-child(2) input[type=color]');
    if (!row || !to) return { skipped: 'need two swatches' };
    if (row.hidden || to.hidden) return { skipped: 'swatches hidden (collapsed section)', row, to };
    const order0 = evalJs(`JSON.stringify(window.__p.options().colorGroups.map((g) => g.query))`).then(json);
    // the colour swatch is the native drag handle; the row body is a text input
    const grab = { x: row.x, y: row.y };
    await mouse('down', grab.x, grab.y, { waitMs: 150 });
    const during = await evalJs(`JSON.stringify({ body: document.body.hasClass('is-grabbing'), ghosts: document.querySelectorAll('.drag-ghost').length, sectionGrabbing: document.querySelectorAll('.graph-control-section .tree-item-children.is-grabbing').length })`).then(json);
    for (let i = 1; i <= 6; i++) await mouse('move', grab.x + i * 4, grab.y + i * 14, { held: 'left', waitMs: 40 });
    const midDrag = await evalJs(`JSON.stringify({ body: document.body.hasClass('is-grabbing'), ghosts: document.querySelectorAll('.drag-ghost').length })`).then(json);
    await mouse('up', to.x, to.y, { waitMs: 800 });
    const order1 = evalJs(`JSON.stringify(window.__p.options().colorGroups.map((g) => g.query))`).then(json);
    return {
      grab,
      rowRect: row,
      targetRect: to,
      during,
      midDrag,
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
      if (!at || at.hidden) break;
      await clickAt(at, 500);
      clicks++;
      n = await evalJs(`document.querySelectorAll('.graph-controls .graph-color-group').length`);
    }
    return { clicks, rowsLeft: n, optionLength: await evalJs(`window.__p.options().colorGroups.length`) };
  });

  // sliders: arrow keys on a focused range input are the native keyboard interaction
  await step('sliderKeys', async () => {
    const open = await ensureOpen('display');
    const at = await control('slider', 'nodeSizeMultiplier');
    if (!at) return { open, skipped: 'no node size slider' };
    if (at.hidden) return { open, skipped: `slider "${at.label}" hidden`, at };
    const v0 = await evalJs(`window.__p.options().nodeSizeMultiplier`);
    await clickAt(at, 300);
    // a track click itself sets the value, so read it before crediting the arrow keys
    const afterClick = await evalJs(`window.__p.options().nodeSizeMultiplier`);
    for (let i = 0; i < 5; i++) await key('ArrowRight', { waitMs: 120 });
    const v1 = await evalJs(`window.__p.options().nodeSizeMultiplier`);
    // read the row that was driven, not the first slider in the section
    const domValue = await evalJs(`(function () {
      const row = document.querySelector('.graph-controls .mod-display [data-fgv-option="nodeSizeMultiplier"]');
      const el = row?.querySelector('input[type=range]');
      return el ? Number(el.value) : null;
    })()`);
    const focused = await evalJs(`document.activeElement?.className ?? null`);
    await clickAt(await control('slider', 'nodeSizeMultiplier'), 200);
    const afterClick2 = await evalJs(`window.__p.options().nodeSizeMultiplier`);
    for (let i = 0; i < 5; i++) await key('ArrowLeft', { waitMs: 120 });
    const v2 = await evalJs(`window.__p.options().nodeSizeMultiplier`);
    const round = (x) => (x === null ? null : Math.round(x * 1e6) / 1e6);
    return {
      open,
      label: at.label,
      at,
      before: round(v0),
      afterClick: round(afterClick),
      afterRight: round(v1),
      keyStepRight: round(v1 - afterClick),
      domValue,
      activeEl: focused,
      afterClick2: round(afterClick2),
      afterLeft: round(v2),
      keyStepLeft: round(v2 - afterClick2),
    };
  });

  // Timelapse. Every stop below is the user control - the row button, the header wand, `Escape`
  // or the palette command - not the engine API, and every sample is timer-driven because the
  // reveal grows on a setInterval and not on a frame.
  const SHAPE = `JSON.stringify((function () {
    const e = window.__p.engine(), m = e.model;
    let files = 0, tags = 0, unres = 0, clusters = 0, iso = 0;
    for (let i = 0; i < m.nodeCount; i++) {
      const k = m.kind[i];
      if (k === 0) files++; else if (k === 2) tags++; else if (k === 3) unres++; else if (k === 4) clusters++;
      if (m.degree[i] === 0) iso++;
    }
    return { nodes: m.nodeCount, edges: m.edgeCount, files, tags, unresolved: unres, clusters,
             isolated: iso, limit: e.progressionLimit ?? null, timelapsing: !!e.timelapsing, overflow: m.overflow };
  })())`;

  /** What the two timelapse controls currently offer, including whether the stop icon is there. */
  const CONTROL = `JSON.stringify((function () {
    const p = window.__p.panel();
    const box = (sel) => {
      const el = p?.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { shown: b.width >= 4 && b.height >= 4, label: el.textContent || null, svgs: el.querySelectorAll('svg').length };
    };
    return { running: !!(p && p.hasClass('is-timelapsing')),
             row: box('.mod-display .setting-item button'),
             animate: box('.graph-controls-button.mod-animate'),
             stop: box('.graph-controls-button.mod-stop') };
  })())`;

  /**
   * The plugin's own timelapse commands, whatever the id prefix is. `Commands` has no
   * `checkCommand`, so availability is read the way the palette reads it: `checkCallback(true)`.
   */
  const commandInfo = async (suffix) =>
    json(
      await evalJs(`(function () {
        const c = app.commands.listCommands().find((x) => new RegExp(':' + ${JSON.stringify(suffix)} + '$').test(x.id ?? ''));
        if (!c) return null;
        const check = typeof c.checkCallback === 'function' ? c.checkCallback(true) : null;
        return JSON.stringify({ id: c.id, name: c.name, available: check === true });
      })()`),
    );
  const runCommand = (suffix) =>
    evalJs(`(function () {
      const c = app.commands.listCommands().find((x) => new RegExp(':' + ${JSON.stringify(suffix)} + '$').test(x.id ?? ''));
      return c ? app.commands.executeCommandById(c.id) : 'no such command';
    })()`);

  await step('timelapse', async () => {
    const before = await evalJs(SHAPE).then(json);
    const idleCommand = await commandInfo('stop-animate');
    await ensureOpen('display');
    const idleControl = await evalJs(CONTROL).then(json);

    // start from the Display row, which must flip to a stop control
    const at = await clickSel('.graph-controls .mod-display .setting-item button', 300);
    if (at?.skipped) return at;
    const startedControl = await evalJs(CONTROL).then(json);
    const runningCommand = await commandInfo('stop-animate');
    const t0 = Date.now();
    const frames = [];
    for (const mark of [300, 2000, 5000]) {
      await sleep(Math.max(0, mark - (Date.now() - t0)));
      frames.push({ atMs: mark, ...(await evalJs(SHAPE).then(json)) });
    }

    // Escape is now a stop control: measure that it halts the reveal and restores the control
    await key('Escape', { waitMs: 600 });
    const afterEscape = await evalJs(SHAPE).then(json);
    const afterEscapeControl = await evalJs(CONTROL).then(json);

    // the same row control starts again, and the same row control stops it a second later
    await clickSel('.graph-controls .mod-display .setting-item button', 1500);
    const restarted = await evalJs(SHAPE).then(json);
    const stoppedAt = await clickSel('.graph-controls .mod-display .setting-item button', 800);
    const stopped = await evalJs(SHAPE).then(json);
    await sleep(2500);
    const stopB = await evalJs(SHAPE).then(json);

    // the row button toggles, so a restart only comes from the command - and one stop must
    // be enough to leave nothing advancing afterwards
    await runCommand('animate');
    await sleep(1200);
    await runCommand('animate');
    const startedByCommand = await evalJs(SHAPE).then(json);
    const controlAfterCommand = await evalJs(CONTROL).then(json);
    await clickSel('.graph-controls .mod-display .setting-item button', 800);
    const haltA = await evalJs(SHAPE).then(json);
    await sleep(2500);
    const haltB = await evalJs(SHAPE).then(json);

    // and the same control through the header wand, which app.css only shows while the panel is closed
    await clickSel('.graph-controls .mod-close', 500);
    const wandAt = await clickSel('.graph-controls .mod-animate', 1500);
    const wand = await evalJs(SHAPE).then(json);
    const wandControl = await evalJs(CONTROL).then(json);
    const wandStopAt = await clickSel('.graph-controls .mod-stop', 800);
    const wandStopped = await evalJs(SHAPE).then(json);
    await clickSel('.graph-controls .mod-open', 400);
    const settled = await settle(60000);

    const last = frames[frames.length - 1] ?? {};
    return {
      at, before, frames,
      grew: last.nodes > (frames[0]?.nodes ?? 0) && last.edges > (frames[0]?.edges ?? 0),
      idleControl, startedControl,
      controlToggles: startedControl?.running === true && idleControl?.running === false,
      escapeStops: !(afterEscape.timelapsing ?? true), afterEscape, afterEscapeControl,
      restarted, stoppedAt, stopped, afterStop2500: stopB,
      advancedAfterStop: stopB.nodes !== stopped.nodes || stopB.limit !== stopped.limit,
      startedByCommand, controlAfterCommand, haltA, haltB,
      stillAdvancing: !!haltB.timelapsing || haltB.nodes !== haltA.nodes || haltB.limit !== haltA.limit,
      wandAt, wand, wandControl, wandStopAt, wandStopped, settled,
      wandSwapped: wandControl?.animate?.shown === false && wandControl?.stop?.shown === true,
      stopIconRendered: wandControl?.stop?.svgs > 0,
      idleCommand, runningCommand,
    };
  });

  // Keyboard camera control: focus on a panel switch must not strand the keys, and a field
  // that reads the same keys must keep them.
  await step('cameraKeys', async () => {
    const CAM = `JSON.stringify((function () {
      const c = window.__p.engine().camera, a = document.activeElement;
      return { panX: Math.round(c.panX), panY: Math.round(c.panY), zoom: Math.round(c.targetZoom * 1000) / 1000,
               active: a ? a.tagName + (a.type ? ':' + a.type : '') : null };
    })())`;
    await ensureOpen('filter');
    const base = await evalJs(CAM).then(json);

    const at = await control('toggle', 'showOrphans');
    if (!at || at.hidden) return { skipped: 'orphans switch not reachable', at };
    await clickAt(at, 500);
    const onSwitch = await evalJs(CAM).then(json);
    await key('ArrowLeft', { waitMs: 200 });
    await key('ArrowUp', { waitMs: 200 });
    await key('Equal', { waitMs: 200 });
    const afterSwitch = await evalJs(CAM).then(json);

    const search = await rect('.graph-controls .mod-filter .search-input-container input');
    await clickAt(search, 300);
    const onField = await evalJs(CAM).then(json);
    await key('ArrowLeft', { waitMs: 200 });
    await key('ArrowUp', { waitMs: 200 });
    await key('Equal', { waitMs: 200 });
    const afterField = await evalJs(CAM).then(json);

    await clickAt(await control('toggle', 'showOrphans'), 900);
    const restored = await settle(45000);
    return {
      base, onSwitch, afterSwitch,
      switchPanned: afterSwitch.panX !== onSwitch.panX && afterSwitch.panY !== onSwitch.panY,
      switchZoomed: afterSwitch.zoom > onSwitch.zoom,
      onField, afterField,
      fieldKeptKeys:
        afterField.panX === afterSwitch.panX && afterField.panY === afterSwitch.panY && afterField.zoom === afterSwitch.zoom,
      restored,
    };
  });

  await step('restoreDefaults', async () => {
    const at = await clickSel('.graph-controls .mod-reset', 1200);
    const settled = await settle(60000);
    return { at, settled, after: await snapshot() };
  });

  await step('workerHealthEnd', health);
  await step('errors', () => evalJs(`(window.__errs ?? []).slice(-8)`));
  await step('status', () => evalJs(`window.__p.view().contentEl.querySelector('.fast-graph-status')?.textContent ?? null`));
  await step('finalCadence', () =>
    evalJs(`(async () => {
      const t0 = performance.now();
      let n = 0;
      await new Promise((r) => { setTimeout(r, 2000); requestAnimationFrame(function loop() { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(loop); else r(); }); });
      return JSON.stringify({ frames: n, ms: Math.round(performance.now() - t0), fps: Math.round((n / (performance.now() - t0)) * 1000 * 10) / 10, vis: document.visibilityState, focus: document.hasFocus() });
    })()`).then(json),
  );
  return out;
}
