// Trusted-input scenario: every interaction here goes through CDP Input events, so the
// app sees real trusted input exactly like a user (hover previews, pointer capture,
// context menus all behave as with a physical mouse).
//
// Two invariants make this reliable on a live 27k-note graph:
//  - wait until the layout loop has idled before aiming at a node, otherwise the node
//    drifts out from under the pointer between the aim and the click;
//  - re-aim immediately before every action and require hitTest() to confirm the target.

const HELPERS = `
(() => {
  const app = window.app;
  const leaf = () => app.workspace.getLeavesOfType('fast-graph-view')[0] ?? null;
  const eng = () => leaf()?.view?.presenter?.engine ?? null;
  const box = () => leaf().view.contentEl.querySelector('.fast-graph-gl').getBoundingClientRect();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // the graph-controls panel floats over the canvas, so a node can be visible yet unreachable
  const clear = (cx, cy) => document.elementFromPoint(cx, cy) === leaf().view.contentEl.querySelector('.fast-graph-gl');
  const aim = (pred) => {
    const e = eng();
    if (!e) return null;
    const b = box();
    for (let i = 0; i < e.model.nodeCount; i++) {
      if (!pred(e.model, i)) continue;
      const x = e.camera.worldToScreenX(e.pos[i * 2]);
      const y = e.camera.worldToScreenY(e.pos[i * 2 + 1]);
      if (x < 24 || y < 24 || x > b.width - 24 || y > b.height - 24) continue;
      if (e.hitTest(x, y) !== i) continue;
      if (!clear(b.left + x, b.top + y)) continue;
      return { i, x: Math.round(b.left + x), y: Math.round(b.top + y) };
    }
    return null;
  };
  const blank = () => {
    const e = eng();
    const b = box();
    for (let y = 60; y < b.height - 60; y += 60) {
      for (let x = 60; x < b.width - 60; x += 60) {
        if (!clear(b.left + x, b.top + y)) continue;
        if (e.hitTest(x, y) < 0 && e.hitTest(x + 50, y) < 0 && e.hitTest(x, y + 50) < 0 && e.hitTest(x - 50, y - 50) < 0) {
          return { x: Math.round(b.left + x), y: Math.round(b.top + y) };
        }
      }
    }
    return null;
  };
  // indices move whenever a folder is revealed or folded, so re-aim by identity instead
  const aimPath = (p) => aim((m, i) => m.kind[i] === 0 && m.path[i] === p);
  const aimFolder = (p) => aim((m, i) => m.kind[i] === 4 && m.path[i] === p);
  const idle = async (budget) => {
    const t0 = Date.now();
    // rAF callbacks are the frame source: 0 of them means the window produced no BeginFrames,
    // so a timeout below is the compositor starving the loop, not the loop refusing to stop
    let frames = 0;
    let stop = false;
    const tick = () => {
      frames++;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const result = () => {
      const e = eng();
      return {
        idle: !!(e && !e.running && e.alpha <= 0.001),
        waited: Date.now() - t0,
        alpha: e?.alpha ?? null,
        frames,
      };
    };
    while (Date.now() - t0 < budget) {
      const e = eng();
      if (e && !e.running && e.alpha <= 0.001) { stop = true; return result(); }
      await sleep(250);
    }
    stop = true;
    return result();
  };
  const fit = async () => {
    const e = eng();
    const c = e.camera;
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let i = 0; i < e.model.nodeCount; i++) {
      const x = e.pos[i * 2], y = e.pos[i * 2 + 1];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    const zoom = Math.min(c.width / (maxx - minx + 600), c.height / (maxy - miny + 600));
    c.zoom = zoom; c.targetZoom = zoom;
    c.panX = c.width / 2 - ((minx + maxx) / 2) * zoom;
    c.panY = c.height / 2 - ((miny + maxy) / 2) * zoom;
    e.needsPaint = true; e.wake();
    await sleep(400);
    return zoom;
  };
  // did Chromium actually deliver the trusted pointer events to the canvas?
  const countPtr = () => {
    const cv = leaf().view.contentEl.querySelector('.fast-graph-gl');
    window.__fgPtr = { down: 0, move: 0, up: 0, cancel: 0 };
    if (cv.dataset.ptrCounted === '1') return 1;
    cv.dataset.ptrCounted = '1';
    for (const [type, key] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel']])
      cv.addEventListener(type, () => window.__fgPtr[key]++, true);
    return 1;
  };
  const ptr = () => JSON.stringify(window.__fgPtr ?? null);
  window.__fg = { leaf, eng, box, aim, aimPath, aimFolder, blank, idle, fit, sleep, clear, countPtr, ptr };
  return 'helpers installed';
})()`;

const RELOAD = `(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!window.__errs) {
    window.__errs = [];
    addEventListener('error', (ev) => window.__errs.push('error: ' + ev.message + ' @' + ev.filename + ':' + ev.lineno));
    addEventListener('unhandledrejection', (ev) => window.__errs.push('reject: ' + String(ev.reason).slice(0, 200)));
    const orig = console.error.bind(console);
    console.error = (...a) => { window.__errs.push('console: ' + a.map(String).join(' ').slice(0, 200)); orig(...a); };
  }
  if (app.plugins.getPlugin('fast-graph-view')) {
    await app.plugins.disablePlugin('fast-graph-view');
    await sleep(500);
  }
  await app.plugins.enablePlugin('fast-graph-view');
  await sleep(700);
  app.workspace.detachLeavesOfType('fast-graph-view');
  app.workspace.detachLeavesOfType('markdown');
  await sleep(400);
  app.commands.executeCommandById('fast-graph-view:open');
  for (let i = 0; i < 200; i++) {
    await sleep(250);
    if (window.__fg?.eng?.()?.model) break;
  }
  return window.__fg.eng() ? 'graph open' : 'NO GRAPH';
})()`;

export default async function ({ evalJs, mouse, wheel, shot, sleep, wake }) {
  const out = {};
  const log = (label, value) =>
    process.stderr.write(`[trusted] ${label} ${JSON.stringify(value ?? null).slice(0, 260)}\n`);

  const read = (expr) =>
    evalJs(
      `(() => { const l = window.__fg.leaf(); if (!l) return 'NOGRAPHLEAF'; ` +
        `const view = l.view, e = view.presenter.engine, app = window.app; return (${expr}); })()`,
    );

  // one guarded step: never let a single action abort the rest of the audit
  const step = async (name, fn) => {
    try {
      const value = await fn();
      out[name] = value;
      log(name, value);
      return value;
    } catch (err) {
      out[name] = { failed: String(err).slice(0, 240) };
      log(`${name} FAILED`, String(err).slice(0, 240));
      return null;
    }
  };

  // A blanked Wayland session starves rAF, so an idle() timeout says nothing about the layout
  // loop. Clear the saver first, and retry when the frame counter proves the wait was starved.
  const settle = async (budget, retries = 2) => {
    await wake();
    const r = await evalJs(`window.__fg.idle(${budget})`);
    const starved = r && !r.idle && (r.frames ?? 0) * 100 < (r.waited ?? 0);
    if (starved && retries > 0) {
      await wake();
      await sleep(1500);
      return settle(budget, retries - 1);
    }
    return r;
  };

  // panX/panY are re-derived from zoom every tick, so during a zoom ease the camera drifts by
  // thousands of px on its own. Nothing may read a pan delta until zoom has caught targetZoom.
  const camQuiet = async (budget = 10000) => {
    await wake();
    const t0 = Date.now();
    for (;;) {
      const c = await read(`({ zoom: e.camera.zoom, target: e.camera.targetZoom })`);
      if (!c || Math.abs(c.zoom - c.target) < 1e-5 || Date.now() - t0 > budget) return c;
      await sleep(150);
    }
  };
  const r2 = (v) => Math.round(v * 1e5) / 1e5;
  const easeDone = (c) => !!c && Math.abs(r2(c.zoom) - r2(c.target)) < 1e-4;

  await evalJs(HELPERS);
  // A blanked session freezes rAF and stalls trusted input; every number below would then
  // look like a plugin defect, so measure the frame source first.
  await step("displayLive", () =>
    evalJs(`(async () => {
      const windows = [];
      for (let w = 0; w < 3; w++) {
        let n = 0;
        const t0 = performance.now();
        requestAnimationFrame(function loop() { n++; if (performance.now() - t0 < 500) requestAnimationFrame(loop); });
        await new Promise((r) => setTimeout(r, 650));
        windows.push(n);
      }
      return JSON.stringify({
        framesPer500ms: windows,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        innerWidth: window.innerWidth,
      });
    })()`),
  );
  await step("reload", () => evalJs(RELOAD));
  await step("settle", () => settle(90000));
  await step("fit", () => evalJs(`window.__fg.fit()`));
  const setup = await step("targets", () =>
    evalJs(
      `(function () {
        const e = window.__fg.eng();
        const cluster = window.__fg.aim((m, i) => m.kind[i] === 4);
        let best = cluster;
        if (cluster) {
          let count = e.model.clusters[e.model.clusterId[cluster.i]].fileCount;
          for (let i = 0; i < e.model.nodeCount; i++) {
            if (e.model.kind[i] !== 4) continue;
            const f = e.model.clusters[e.model.clusterId[i]].fileCount;
            const hit = window.__fg.aim((m, j) => j === i);
            if (hit && f > count) { count = f; best = hit; }
          }
        }
        return JSON.stringify({
          cluster: best ? { ...best, folder: e.model.path[best.i], label: e.model.label[best.i] } : null,
          file: window.__fg.aim((m, i) => m.kind[i] === 0),
          tag: window.__fg.aim((m, i) => m.kind[i] === 2),
          stage: (() => { const b = window.__fg.box(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; })(),
          nodes: e.model.nodeCount,
        });
      })()`,
    ).then((s) => (s ? JSON.parse(s) : null)),
  );

  const filePath = setup?.file
    ? await read(`window.__fg.eng().model.path[${setup.file.i}]`)
    : null;
  const folder = setup?.cluster?.folder ?? null;

  // 1) trusted hover over a folded folder -> metadata card
  if (setup?.cluster) {
    await mouse('move', setup.cluster.x - 60, setup.cluster.y - 60, { waitMs: 120 });
    await mouse('move', setup.cluster.x, setup.cluster.y, { waitMs: 900 });
    await step("clusterHoverCard", () =>
      read(
        `(function(){ const c = view.contentEl.querySelector('.fast-graph-card'); return c ? c.innerText.replace(/\\n+/g,' | ').slice(0,200) : null; })()`,
      ),
    );
    await step("shotClusterHover", () => shot('/tmp/shots/trusted-cluster-hover.png'));

    // 2) trusted left click -> reveal a batch; trusted right click -> fold it again
    const before = await read(`e.revealedCount(${JSON.stringify(folder)})`);
    await mouse('click', setup.cluster.x, setup.cluster.y, { waitMs: 1200 });
    const afterLeft = await read(`e.revealedCount(${JSON.stringify(folder)})`);
    await step("clusterClick", async () => ({
      folder,
      before,
      afterLeft,
      graphLeafStillOpen: !!(await read(`!!window.__fg.leaf()`)),
      nodesNow: await read(`e.model.nodeCount`),
    }));
    await step("shotClusterRevealed", () => shot('/tmp/shots/trusted-cluster-revealed.png'));

    const reAim = await step("clusterReAim", async () => {
      const settled = await settle(45000);
      const at = await evalJs(
        `JSON.stringify(window.__fg.aimFolder(${JSON.stringify(folder)}))`,
      ).then((s) => JSON.parse(s));
      return { settled, at };
    });
    if (reAim?.at) {
      await mouse('click', reAim.at.x, reAim.at.y, { button: 'right', waitMs: 1200 });
      await step("clusterRightClick", async () => ({
        afterRight: await read(`e.revealedCount(${JSON.stringify(folder)})`),
        menuOpened: await read(`!!document.querySelector('.menu')`),
        nodesBackToStart: await read(`e.model.nodeCount`),
      }));
    }
  }

  // 3) trusted hover over a file node -> core page-preview popover
  const fileAim = async () => {
    await settle(30000);
    return JSON.parse(
      await evalJs(`JSON.stringify(window.__fg.aimPath(${JSON.stringify(filePath ?? '')}))`),
    );
  };
  if (setup?.file) {
    const at = await fileAim();
    if (at) {
      out.fileTarget = at;
      await mouse('move', at.x - 50, at.y - 50, { waitMs: 200 });
      await mouse('move', at.x, at.y, { waitMs: 1800 });
      await step("fileHoverPreview", async () => ({
        aimed: at.i,
        hoverNode: await read(`e.hoverNode`),
        pagePreviewEnabled: await read(`!!app.internalPlugins?.getEnabledPluginById('page-preview')`),
        hoverSource: await read(`view.presenter.init?.deps?.hoverSource ?? null`),
        lastHoverLink: await read(`view.presenter.lastHoverLink ?? null`),
        popoversAnywhere: await read(`document.querySelectorAll('.popover').length`),
        popover: await read(`!!document.querySelector('.popover .hover-popover, .hover-popover')`),
        text: await read(
          `(document.querySelector('.hover-popover .markdown-rendered, .hover-popover .markdown-preview-view')?.innerText ?? '').replace(/\\n+/g,' ').slice(0,70)`,
        ),
        ourPopover: await read(`view.presenter.hoverPopover ? 'set' : 'null'`),
        cardStillThere: await read(`!!view.contentEl.querySelector('.fast-graph-card')`),
      }));
      await step("shotFileHover", () => shot('/tmp/shots/trusted-hover-preview.png'));
      await read(`(function(){ window.__fg.eng().setHover(-1); return 1; })()`);
      await mouse('move', setup.stage.x + 12, setup.stage.y + setup.stage.h - 40, { waitMs: 400 });

      // core registers the `graph` hover source with defaultMod: true, so the native rule is
      // that a plain hover only shows our cluster card while Mod-held hover opens page preview
      const at2 = await fileAim();
      if (at2) {
        await mouse('move', at2.x - 50, at2.y - 50, { waitMs: 200 });
        await mouse('move', at2.x, at2.y, { ctrl: true, waitMs: 2600 });
        await step("fileHoverPreviewWithCtrl", async () => ({
          aimed: at2.i,
          hoverNode: await read(`e.hoverNode`),
          ctrlKeyOnEvent: await read(`e.lastEvt?.ctrlKey ?? null`),
          popoversAnywhere: await read(`document.querySelectorAll('.popover').length`),
          popover: await read(`!!document.querySelector('.popover .hover-popover, .hover-popover')`),
          text: await read(
            `(document.querySelector('.hover-popover .markdown-rendered, .hover-popover .markdown-preview-view')?.innerText ?? '').replace(/\\n+/g,' ').slice(0,70)`,
          ),
          previewLeafType: await read(`app.workspace.getLeavesOfType('hover-editor').length`),
          cardStillThere: await read(`!!view.contentEl.querySelector('.fast-graph-card')`),
        }));
        await step("shotCtrlHover", () => shot('/tmp/shots/trusted-hover-preview-ctrl.png'));
        await read(`(function(){ window.__fg.eng().setHover(-1); return 1; })()`);
        await mouse('move', setup.stage.x + 12, setup.stage.y + setup.stage.h - 40, { waitMs: 400 });
      }
    }
  }

  // 4) trusted wheel zoom + pan drag on confirmed empty space
  await step("wheelZoom", async () => {
    const read2 = () =>
      read(`JSON.stringify({ zoom: e.camera.zoom, target: e.camera.targetZoom })`).then((s) => JSON.parse(s));
    const cam0 = await read2();
    const via = [];
    via.push(await wheel(setup.stage.x + 200, setup.stage.y + 200, -400, { waitMs: 250 }));
    via.push(await wheel(setup.stage.x + 200, setup.stage.y + 200, -400, { waitMs: 400 }));
    const camMid = await read2();
    await settle(15000);
    const cam1 = await read2();
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
      via,
      before: { zoom: r(cam0.zoom), target: r(cam0.target) },
      immediatelyAfter: r(camMid.zoom),
      after: { zoom: r(cam1.zoom), target: r(cam1.target) },
    };
  });

  await step("panDrag", async () => {
    const at = JSON.parse(await evalJs(`JSON.stringify(window.__fg.blank())`));
    if (!at) return { skipped: 'no blank point' };
    const cam0 = await camQuiet();
    if (!easeDone(cam0)) return { skipped: 'zoom ease running - pan readings would be re-anchoring', cam0 };
    await evalJs(`window.__fg.countPtr()`);
    const p0 = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    await mouse('down', at.x, at.y, { waitMs: 100 });
    const grabbing = await read(`view.contentEl.hasClass('is-grabbing')`);
    for (let i = 1; i <= 10; i++) await mouse('move', at.x + i * 14, at.y + i * 4, { waitMs: 25 });
    const dragEnd = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    await mouse('up', at.x + 140, at.y + 40, { waitMs: 120 });
    // the glide is inertia after the release: it must stay bounded, never a vault-wide fling
    const velocity = await read(
      `({ vx: Math.round(e.camera.velocityX * 1000) / 1000, vy: Math.round(e.camera.velocityY * 1000) / 1000, gliding: e.camera.gliding, width: Math.round(e.camera.width) })`,
    );
    const p1 = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    const settled = await settle(15000);
    const p2 = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    const cam1 = await read(`({ zoom: e.camera.zoom, target: e.camera.targetZoom })`);
    return {
      at,
      grabbingDuring: grabbing,
      panFrom: p0,
      dragEnd,
      movedBy: { dx: dragEnd.x - p0.x, dy: dragEnd.y - p0.y },
      pointerDelta: { dx: 140, dy: 40 },
      velocityAtRelease: velocity,
      glide: { dx: p2.x - p1.x, dy: p2.y - p1.y, magnitude: Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y)) },
      panSettled: p2,
      settled,
      zoomSteadyThroughout: easeDone(cam1) && Math.abs(r2(cam1.zoom) - r2(cam0.zoom)) < 1e-5,
      grabbingCleared: await read(`!view.contentEl.hasClass('is-grabbing')`),
      stillPanning: await read(`e.panning`),
      ptr: JSON.parse(await evalJs(`window.__fg.ptr()`)),
      grabElements: await read(
        `[...document.querySelectorAll('.is-grabbing')].map((el) => el.tagName.toLowerCase() + '.' + [...el.classList].join('.')).join(', ') || 'none'`,
      ),
      noNodeDragged: await read(`e.dragNode`),
    };
  });

  // releasing outside the canvas never reaches its pointerup listener - the window-level
  // fallback has to end the pan, or the next pointermove teleports the view
  await step("panReleaseOutside", async () => {
    const at = JSON.parse(await evalJs(`JSON.stringify(window.__fg.blank())`));
    if (!at) return { skipped: 'no blank point' };
    const b = JSON.parse(await evalJs(`(function(){ const r = window.__fg.box(); return JSON.stringify({ top: r.top, right: r.right }); })()`));
    const cam0 = await camQuiet();
    if (!easeDone(cam0)) return { skipped: 'zoom ease running - pan readings would be re-anchoring', cam0 };
    await evalJs(`window.__fg.countPtr()`);
    const p0 = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    await mouse('down', at.x, at.y, { waitMs: 100 });
    for (let i = 1; i <= 5; i++) await mouse('move', at.x + i * 10, at.y - i * 20, { waitMs: 25 });
    await mouse('move', b.right - 30, b.top - 30, { waitMs: 60 });
    await mouse('up', b.right - 30, b.top - 30, { waitMs: 500 });
    const p1 = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    return {
      at,
      releaseAt: { x: b.right - 30, y: b.top - 30 },
      panMoved: { dx: p1.x - p0.x, dy: p1.y - p0.y },
      inCanvasDelta: { dx: 50, dy: -100 },
      pointerTravel: { dx: Math.round(b.right - 30 - at.x), dy: Math.round(b.top - 30 - at.y) },
      camAtRelease: await read(`({ zoom: e.camera.zoom, target: e.camera.targetZoom })`),
      canvasSawUp: JSON.parse(await evalJs(`window.__fg.ptr()`)).up,
      stillPanning: await read(`e.panning`),
      grabbingCleared: await read(`!view.contentEl.hasClass('is-grabbing')`),
      grabElements: await read(
        `[...document.querySelectorAll('.is-grabbing')].map((el) => el.tagName.toLowerCase() + '.' + [...el.classList].join('.')).join(', ') || 'none'`,
      ),
    };
  });

  // the wheel and pan steps leave the viewport framed elsewhere: re-fit so the aimed note
  // is on screen again before testing drag and click navigation
  await step("refit", async () => {
    const zoom = await evalJs(`window.__fg.fit()`);
    const settled = await settle(20000);
    return { zoom, settled };
  });

  // The fling condition: a stalled compositor delivers a whole drag step inside one
  // millisecond. Dispatch moves back to back with no wait and see what the camera makes of it.
  await step("panBurst", async () => {
    const at = JSON.parse(await evalJs(`JSON.stringify(window.__fg.blank())`));
    if (!at) return { skipped: 'no blank point' };
    const cam0 = await camQuiet();
    if (!easeDone(cam0)) return { skipped: 'zoom ease running - pan readings would be re-anchoring', cam0 };
    await evalJs(`(function () {
      const c = window.__fg.eng().camera;
      if (!c.__rec) {
        const orig = c.trackPan.bind(c);
        c.__samples = [];
        c.trackPan = function (dx, dy, t) {
          c.__samples.push([Math.round(dx), Math.round(dy), Math.round(t - (c.lastMoveTime || t))]);
          return orig(dx, dy, t);
        };
      }
      c.__samples.length = 0;
      return 1;
    })()`);
    const p0 = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    await mouse('down', at.x, at.y, { waitMs: 100 });
    for (let i = 1; i <= 6; i++) await mouse('move', at.x + i * 30, at.y + i * 4, { waitMs: 0 });
    const dragEnd = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    await mouse('up', at.x + 180, at.y + 24, { waitMs: 120 });
    const velocity = await read(
      `({ vx: Math.round(e.camera.velocityX * 1000) / 1000, gliding: e.camera.gliding, paneWidth: Math.round(e.camera.width) })`,
    );
    const p1 = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    const settled = await settle(15000);
    const p2 = await read(`({x: Math.round(e.camera.panX), y: Math.round(e.camera.panY)})`);
    const samples = JSON.parse(await evalJs(`JSON.stringify(window.__fg.eng().camera.__samples)`));
    // replay what the unbounded model would have sampled on the same input
    let ox = 0;
    let oy = 0;
    for (const [dx, dy, dt] of samples) {
      const d = dt > 0 ? dt : 16;
      ox = ox * 0.8 + (dx / d) * 0.2;
      oy = oy * 0.8 + (dy / d) * 0.2;
    }
    const glide = Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y));
    const cap = (velocity.paneWidth * (1 - 0.9)) / (1000 / 60);
    return {
      at,
      samples,
      panFrom: p0,
      dragEnd,
      movedBy: { dx: dragEnd.x - p0.x, dy: dragEnd.y - p0.y },
      velocityAtRelease: velocity,
      velocityCapPxPerMs: Math.round(cap * 1000) / 1000,
      glide,
      glideWithinOnePane: glide <= velocity.paneWidth,
      panSettled: p2,
      settled,
      uncappedGlideWouldBe: Math.round(Math.hypot(ox, oy) * (1000 / 60) * 10),
      stillPanning: await read(`e.panning`),
      grabbingCleared: await read(`!view.contentEl.hasClass('is-grabbing')`),
    };
  });
  // 5) trusted node drag: pin, move, release
  if (setup?.file) {
    await step("nodeDrag", async () => {
      const at = await fileAim();
      if (!at) return { skipped: 'note not hittable after zoom/pan' };
      await evalJs(`window.__fg.countPtr()`);
      const w0 = await read(`({ x: e.pos[${at.i} * 2], y: e.pos[${at.i} * 2 + 1] })`);
      await mouse('down', at.x, at.y, { waitMs: 120 });
      const grabbed = await read(`e.dragNode`);
      for (let i = 1; i <= 8; i++) await mouse('move', at.x + i * 12, at.y + i * 9, { waitMs: 40 });
      const reheated = await read(`Math.round(e.alpha * 1000) / 1000`);
      await mouse('up', at.x + 96, at.y + 72, { waitMs: 900 });
      const w1 = await read(`({ x: e.pos[${at.i} * 2], y: e.pos[${at.i} * 2 + 1] })`);
      return {
        at,
        ptr: JSON.parse(await evalJs(`window.__fg.ptr()`)),
        dragNodeOnPress: grabbed,
        alphaDuringDrag: reheated,
        worldMoved: Math.round(Math.hypot(w1.x - w0.x, w1.y - w0.y)),
        from: { x: Math.round(w0.x), y: Math.round(w0.y) },
        released: await read(`e.dragNode`),
        graphLeafStillOpen: !!(await read(`!!window.__fg.leaf()`)),
        activeFileAfterDrag: await read(`app.workspace.getActiveFile()?.path ?? null`),
      };
    });
  }

  await step("idleLoopStops", async () => {
    const settled = await settle(30000);
    await evalJs(
      `(function () { const e = window.__fg.eng(); if (!e.__counted) { e.__counted = true; const orig = e.paint.bind(e); e.paint = () => { e.__painted++; orig(); }; } e.__painted = 0; return 1; })()`,
    );
    const state = await read(`({ running: e.running, alpha: Math.round(e.alpha * 1e5) / 1e5, raf: e.raf })`);
    await sleep(2000);
    const idlePaints = await read(`e.__painted`);
    await wheel(setup.stage.x + 200, setup.stage.y + 200, -300, { waitMs: 200 });
    const afterWake = await read(`e.running`);
    await sleep(300);
    const wokePaints = await read(`e.__painted`);
    await settle(30000);
    const base = await read(`e.__painted`);
    await sleep(2000);
    return {
      settled,
      stateAfterSettle: state,
      idlePaints,
      runningAfterWheel: afterWake,
      paintsDuringWheel: wokePaints - idlePaints,
      paintsAfterResettle: (await read(`e.__painted`)) - base,
    };
  });

  await step("errors", () => read(`(window.__errs ?? []).slice(-6)`));
  await step("status", () => read(`view.contentEl.querySelector('.fast-graph-status')?.textContent ?? null`));

  // idleLoopStops leaves the viewport framed by its wheel step: re-fit so the note is hittable
  await step("refitForClick", async () => {
    let zoom = await evalJs(`window.__fg.fit()`);
    let settled = await settle(20000);
    let at = await fileAim();
    if (!at) {
      zoom = await evalJs(`(function(){ const c = window.__fg.eng().camera; c.zoom = c.zoom * 0.5; c.targetZoom = c.zoom; window.__fg.eng().wake(); return c.zoom; })()`);
      settled = await settle(20000);
      at = await fileAim();
    }
    return { zoom, settled, at };
  });

  // 6) trusted plain click on a file node: core makes a graph leaf navigable, so the note
  //    opens in that same leaf and the leaf's own history has to bring the graph back.
  //    Last in the scenario because the navigation destroys the graph leaf every other step reads.
  if (setup?.file) {
    await step("stashGraphLeaf", () =>
      evalJs(`(function () { window.__navLeaf = window.__fg.leaf(); return window.__navLeaf ? 1 : 0; })()`),
    );
    await step("fileClickNavigates", async () => {
      const at = await fileAim();
      if (!at) return { skipped: 'note not hittable' };
      await mouse('click', at.x, at.y, { waitMs: 1500 });
      const after = JSON.parse(
        await evalJs(`(function () {
          const app = window.app, l = window.__navLeaf;
          return JSON.stringify({
            navLeafView: l?.view?.getViewType?.() ?? null,
            active: app.workspace.getActiveFile()?.path ?? null,
            graphLeaves: app.workspace.getLeavesOfType('fast-graph-view').length,
            markdownLeaves: app.workspace.getLeavesOfType('markdown').length,
            backHistory: l?.history?.backHistory?.length ?? null,
            forwardHistory: l?.history?.forwardHistory?.length ?? null,
          });
        })()`),
      );
      return { at, expected: filePath, ...after };
    });
    await step("shotFileClick", () => shot('/tmp/shots/trusted-file-click.png'));
    await step("backToGraph", async () => {
      const how = await evalJs(`(function () {
        const l = window.__navLeaf;
        if (!l?.history?.go) return 'no leaf.history.go';
        l.history.go(-1);
        return 'leaf.history.go(-1)';
      })()`);
      const ready = await evalJs(
        `(async () => { for (let i = 0; i < 60; i++) { await window.__fg.sleep(250); if (window.__fg.eng()?.model) return 'engine ready after ' + ((i + 1) * 250) + ' ms'; } return 'no engine after 15 s'; })()`,
      );
      const after = JSON.parse(
        await evalJs(`(function () {
          const app = window.app, l = window.__navLeaf;
          return JSON.stringify({
            navLeafView: l?.view?.getViewType?.() ?? null,
            graphLeaves: app.workspace.getLeavesOfType('fast-graph-view').length,
            forwardHistory: l?.history?.forwardHistory?.length ?? null,
          });
        })()`),
      );
      return { how, ready, ...after };
    });
  }

  await step("errorsAfterNav", () =>
    evalJs(`JSON.stringify((window.__errs ?? []).slice(-6))`).then((s) => JSON.parse(s)),
  );
  return out;
}
