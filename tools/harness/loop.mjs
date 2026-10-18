// Render-loop lifecycle proof: when the loop paints, when it stops, what wakes it.
//
// A setTimeout-backed requestAnimationFrame is installed ONLY when native rAF is dead.
// If the desktop session is blanked (org.gnome.ScreenSaver GetActive = true), Mutter stops
// handing BeginFrames to Chromium and rAF fires 0 times per second; the shim supplies the
// ticks so the semantics stay testable. With a lit display the real 60 Hz loop is measured.

const SHIM_ON = `(() => {
  if (window.__realRaf) return 'already shimmed';
  window.__realRaf = window.requestAnimationFrame.bind(window);
  window.__cancelReal = window.cancelAnimationFrame.bind(window);
  window.__turns = 0;
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (h) => clearTimeout(h);
  return 'shimmed';
})()`;

const SHIM_OFF = `(() => {
  if (!window.__realRaf) return 'not shimmed';
  window.requestAnimationFrame = window.__realRaf;
  window.cancelAnimationFrame = window.__cancelReal;
  delete window.__realRaf;
  return 'restored';
})()`;

export default async function ({ evalJs, mouse, wheel, shot, sleep }) {
  const out = {};
  const log = (label, value) =>
    process.stderr.write(`[loop] ${label} ${JSON.stringify(value ?? null).slice(0, 240)}\n`);

  const eng = `(window.app.workspace.getLeavesOfType('graph')[0].view.presenter.engine)`;
  const read = (expr) => evalJs(`(() => { const e = ${eng}; const app = window.app; return (${expr}); })()`);
  const step = async (name, fn) => {
    try {
      const v = await fn();
      out[name] = v;
      log(name, v);
      return v;
    } catch (err) {
      out[name] = { failed: String(err).slice(0, 200) };
      log(`${name} FAILED`, String(err).slice(0, 200));
      return null;
    }
  };

  const instrument = `(() => {
    const e = ${eng};
    if (!e.__painted) {
      e.__painted = 0;
      const orig = e.paint.bind(e);
      e.paint = () => { e.__painted++; orig(); };
    }
    e.__painted = 0;
    return 1;
  })()`;

  const snapshot = `(() => {
    const e = ${eng};
    return JSON.stringify({
      running: e.running, painted: e.__painted, idleFrames: e.idleFrames,
      alpha: Math.round(e.alpha * 1e5) / 1e5, needsPaint: e.needsPaint,
      zoom: Math.round(e.camera.zoom * 1e4) / 1e4, targetZoom: Math.round(e.camera.targetZoom * 1e4) / 1e4,
      gliding: e.camera.gliding, hoverNode: e.hoverNode, nodes: e.model.nodeCount,
    });
  })()`;

  const ptrState = async () =>
    JSON.parse(
      await evalJs(`(function(){ const e = ${eng}; return JSON.stringify({
        painted: e.__painted, running: e.running, alpha: Math.round(e.alpha * 1e5) / 1e5,
        dragNode: e.dragNode, panning: e.panning, pointerActive: e.pointerActive,
        ptr: window.__ptr.down + '/' + window.__ptr.move + '/' + window.__ptr.up,
      }); })()`),
    );

  const nativeRaf = JSON.parse(
    await evalJs(`(async () => {
      let n = 0;
      const t0 = performance.now();
      requestAnimationFrame(function loop() { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(loop); });
      await new Promise((r) => setTimeout(r, 1200));
      return JSON.stringify({ framesIn1s: n, visibility: document.visibilityState, focused: document.hasFocus() });
    })()`),
  );
  out.nativeRaf = nativeRaf;
  log('nativeRaf', nativeRaf);
  const needsShim = nativeRaf.framesIn1s < 5;

  await step('shimOn', () => (needsShim ? evalJs(SHIM_ON) : 'skipped - native rAF is live'));
  await step('open', () =>
    evalJs(`(async () => {
      const app = window.app;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      app.workspace.detachLeavesOfType('graph');
      await sleep(600);
      const has = () => app.workspace.getLeavesOfType('graph')[0]?.view?.presenter?.engine?.model ?? null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        app.commands.executeCommandById('graph:open');
        for (let i = 0; i < 60; i++) {
          await sleep(250);
          if (has()) return 'graph open on attempt ' + attempt + ', nodes=' + has().nodeCount;
        }
        const leaf = app.workspace.getLeaf(true);
        try {
          await leaf.setViewState({ type: 'graph', active: true });
        } catch (err) {
          if (attempt === 3) return 'FAILED to open graph: ' + err.message;
        }
        await sleep(500);
      }
      return 'NO GRAPH after 3 attempts';
    })()`),
  );

  await step('instrument', () => evalJs(instrument));
  await step('wake', () =>
    evalJs(`(() => { const e = ${eng}; e.running = false; e.raf = 0; e.idleFrames = 0; e.wake(); return JSON.stringify({ running: e.running, raf: e.raf }); })()`),
  );

  // let the layout run to completion
  const trace = [];
  let settledInMs = null;
  const tSettle = Date.now();
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const s = JSON.parse(await evalJs(snapshot));
    trace.push(s);
    if (!s.running && s.alpha <= 0.001) {
      settledInMs = Date.now() - tSettle;
      break;
    }
  }
  out.settleTrace = trace;
  out.settledInMs = settledInMs;
  log('settledInMs', settledInMs ?? 'NEVER STOPPED within 60 s');
  log("settle:last", trace[trace.length - 1]);

  await step('idleStaysStopped', async () => {
    const before = JSON.parse(await evalJs(snapshot));
    await sleep(3000);
    const after = JSON.parse(await evalJs(snapshot));
    return { before, after, paintsWhileIdle: after.painted - before.painted };
  });

  const box = JSON.parse(
    await evalJs(`(function(){ const l = window.app.workspace.getLeavesOfType('graph')[0]; const b = l.view.contentEl.querySelector('.fast-graph-gl').getBoundingClientRect(); return JSON.stringify({x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height)}); })()`),
  );
  out.stage = box;

  await step('wheelWakesLoop', async () => {
    const before = JSON.parse(await evalJs(snapshot));
    await wheel(box.x + 200, box.y + 200, -320, { waitMs: 120 });
    const during = JSON.parse(await evalJs(snapshot));
    await sleep(6000);
    const after = JSON.parse(await evalJs(snapshot));
    return {
      runningBefore: before.running,
      zoomBefore: before.zoom,
      runningDuring: during.running,
      paintedDuring: during.painted - before.painted,
      zoomAfter: after.zoom,
      stoppedAgain: !after.running,
      paintsAfterSettle: after.painted - during.painted,
    };
  });

  await step('dragWakesLoop', async () => {
    const target = JSON.parse(
      await evalJs(`(function(){ const e = ${eng}; const l = window.app.workspace.getLeavesOfType('graph')[0]; const cv = l.view.contentEl.querySelector('.fast-graph-gl'); const b = cv.getBoundingClientRect();
        let covered = 0;
        for (let i = 0; i < e.model.nodeCount; i++) { const x = e.camera.worldToScreenX(e.pos[i*2]), y = e.camera.worldToScreenY(e.pos[i*2+1]);
          if (x < 40 || y < 40 || x > b.width - 40 || y > b.height - 40) continue; if (e.hitTest(x, y) !== i) continue;
          // the graph-controls panel floats over the canvas: visible is not the same as reachable
          if (document.elementFromPoint(b.left + x, b.top + y) !== cv) { covered++; continue; }
          return JSON.stringify({ i, x: Math.round(b.left + x), y: Math.round(b.top + y), covered }); }
        return JSON.stringify({ covered }); })()`),
    );
    if (target.i === undefined) return { skipped: 'no reachable node', covered: target.covered };
    // capture-phase counters on the canvas: did Chromium deliver the trusted events at all?
    await evalJs(`(() => {
      const cv = window.app.workspace.getLeavesOfType('graph')[0].view.contentEl.querySelector('.fast-graph-gl');
      window.__ptr = { down: 0, move: 0, up: 0 };
      for (const [type, key] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up']])
        cv.addEventListener(type, () => window.__ptr[key]++, true);
      return 1;
    })()`);
    const before = JSON.parse(await evalJs(snapshot));
    const samples = [];
    await mouse('down', target.x, target.y, { waitMs: 60 });
    samples.push({ at: 'down', ...(await ptrState()) });
    for (let i = 1; i <= 6; i++) {
      await mouse('move', target.x + i * 10, target.y + i * 8, { waitMs: 60, held: 'left' });
      samples.push({ at: 'move' + i, ...(await ptrState()) });
    }
    await mouse('up', target.x + 60, target.y + 48, { waitMs: 60 });
    samples.push({ at: 'up', ...(await ptrState()) });
    const during = JSON.parse(await evalJs(snapshot));
    await sleep(8000);
    const after = JSON.parse(await evalJs(snapshot));
    return {
      target,
      before,
      ptrEvents: await evalJs(`JSON.stringify(window.__ptr)`),
      samples,
      runningDuring: during.running,
      paintedDuringDrag: during.painted - before.painted,
      paintedTotal: during.painted,
      paintsAfterRelease: after.painted - during.painted,
      stillRunning: after.running,
      alpha: after.alpha,
    };
  });

  await step('shotLoop', () => shot('/tmp/shots/loop-final.png'));
  await step('shimOff', () => evalJs(SHIM_OFF));
  await step('errors', () => read(`(window.__errs ?? []).slice(-4)`));
  return out;
}
