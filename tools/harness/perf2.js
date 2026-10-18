(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plugin = app.plugins.getPlugin('fast-graph-view');
  const origRaf = window.requestAnimationFrame.bind(window);

  // The compositor is not producing frames for this window right now, so drive
  // the engine's own loop from a timer instead of depending on display vsync.
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);

  // how long a setTimeout(0) actually waits: high values mean the main thread is busy
  const lagWindow = (ms) =>
    new Promise((res) => {
      const end = performance.now() + ms;
      let prev = performance.now();
      let worst = 0;
      const step = () => {
        const now = performance.now();
        worst = Math.max(worst, now - prev);
        prev = now;
        if (now < end) setTimeout(step, 0);
        else res(Math.round(worst * 10) / 10);
      };
      setTimeout(step, 0);
    });

  const measure = async (label, seconds) => {
    app.workspace.detachLeavesOfType('graph');
    await sleep(300);
    app.commands.executeCommandById('graph:open');
    let view = null;
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      view = app.workspace.getLeavesOfType('graph')[0]?.view ?? null;
      if (view?.presenter?.engine?.renderer) break;
    }
    if (!view) return { label, error: 'no view' };
    const e = view.presenter.engine;
    const r = e.renderer;
    const t0 = performance.now();
    let frames = 0;
    const samples = [];
    while ((performance.now() - t0) / 1000 < seconds) {
      const before = r.framesRendered;
      const lag = await lagWindow(1000);
      frames += r.framesRendered - before;
      samples.push(lag);
    }
    const wall = (performance.now() - t0) / 1000;
    const out = {
      label,
      nodes: e.model?.nodeCount ?? 0,
      edges: e.model?.edgeCount ?? 0,
      buildMs: Math.round(e.lastBuildMs * 10) / 10,
      frames,
      fps: Math.round((frames / wall) * 10) / 10,
      lastFrameMs: Math.round(r.lastFrameMs * 100) / 100,
      worker: e.driver.usingWorker,
      mainThreadLagMs: samples,
      status: view.contentEl.querySelector('.fast-graph-status')?.textContent ?? null,
    };
    app.workspace.detachLeavesOfType('graph');
    await sleep(200);
    return out;
  };

  const results = [];
  results.push(await measure('clustering on (threshold 20)', 6));

  plugin.settings.cluster.enabled = false;
  plugin.saveSettings?.();
  results.push(await measure('clustering off (every note)', 6));
  plugin.settings.cluster.enabled = true;
  plugin.saveSettings?.();

  window.requestAnimationFrame = origRaf;
  return JSON.stringify({ rafDriven: 'timer-shimmed', results }, null, 1);
})()
