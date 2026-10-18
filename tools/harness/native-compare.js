(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lagWindow = (ms) =>
    new Promise((res) => {
      const end = performance.now() + ms;
      let prev = performance.now();
      let worst = 0;
      let total = 0;
      const step = () => {
        const now = performance.now();
        const d = now - prev;
        worst = Math.max(worst, d);
        total += d;
        prev = now;
        if (now < end) setTimeout(step, 0);
        else res({ worst: Math.round(worst * 10) / 10, sum: Math.round(total) });
      };
      setTimeout(step, 0);
    });

  app.workspace.detachLeavesOfType('graph');
  await sleep(400);
  await app.plugins.disablePlugin('fast-graph-view');
  await sleep(600);

  const t0 = performance.now();
  app.commands.executeCommandById('graph:open');
  let view = null;
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    view = app.workspace.getLeavesOfType('graph')[0]?.view ?? null;
    if (view?.contentEl?.querySelector('canvas')) break;
  }
  const firstCanvasMs = Math.round(performance.now() - t0);
  const isNative = !view?.contentEl?.querySelector('.fast-graph-gl');

  const lags = [];
  for (let i = 0; i < 10; i++) lags.push(await lagWindow(1000));
  const canvas = view.contentEl.querySelector('canvas');
  const r = canvas.getBoundingClientRect();

  return JSON.stringify({
    engine: isNative ? 'native' : 'ours',
    firstCanvasMs,
    canvasCss: Math.round(r.width) + 'x' + Math.round(r.height),
    canvasBacking: canvas.width + 'x' + canvas.height,
    nativeMainThreadLag: lags,
    graphJsonScale: app.internalPlugins.getPluginById('graph')?.instance?.options?.scale ?? null,
    status: view.contentEl.querySelector('.fast-graph-status')?.textContent ?? null,
    controls: !!view.contentEl.querySelector('.graph-controls'),
  }, null, 1);
})()
