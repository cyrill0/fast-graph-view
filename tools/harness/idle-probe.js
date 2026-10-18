(async () => {
  const app = window.app;
  const e = app.workspace.getLeavesOfType('graph')[0].view.presenter.engine;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r = {
    frames: 0, paints: 0, tickMoved: 0, fadesTrue: 0, wakes: 0,
    simFrames: 0, resizes: 0, hoverSets: 0, needsPaintAtPaint: 0,
  };

  const targets = [];
  const wrap = (obj, name, hook) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    const wrapper = function (...a) {
      hook();
      return orig.apply(this, a);
    };
    obj[name] = wrapper;
    targets.push([obj, name, orig]);
  };

  wrap(e, 'paint', () => { r.paints++; if (e.needsPaint) r.needsPaintAtPaint++; });
  wrap(e, 'frame', () => { r.frames++; });
  wrap(e, 'wake', () => { r.wakes++; });
  wrap(e, 'resize', () => { r.resizes++; });
  wrap(e, 'setHover', () => { r.hoverSets++; });
  wrap(e, 'onSimFrame', () => { r.simFrames++; });
  wrap(e, 'fadesEasing', () => {});
  const fadesOrig = targets.find((t) => t[1] === 'fadesEasing')?.[2];
  if (fadesOrig) {
    e.fadesEasing = function () { const v = fadesOrig.call(this); if (v) r.fadesTrue++; return v; };
  }
  wrap(e.camera, 'tick', () => {});
  const tickOrig = targets[targets.length - 1][2];
  e.camera.tick = function () { const moved = tickOrig.call(this); if (moved) r.tickMoved++; return moved; };

  const samples = [];
  for (let i = 0; i < 8; i++) {
    await sleep(350);
    samples.push({
      running: e.running,
      alpha: Math.round(e.alpha * 1e6) / 1e6,
      idleFrames: e.idleFrames,
      pointerActive: e.pointerActive,
      hoverNode: e.hoverNode,
      needsPaint: e.needsPaint,
      simAlpha: e.driver?.alpha ?? null,
      settled: e.driver?.settled ?? null,
    });
  }

  for (const [obj, name, orig] of targets) obj[name] = orig;
  return JSON.stringify({ counters: r, samples });
})()
