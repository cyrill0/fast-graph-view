(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!app.plugins.getPlugin('fast-graph')) {
    await app.plugins.enablePlugin('fast-graph');
    await sleep(800);
  }
  app.workspace.detachLeavesOfType('graph');
  await sleep(400);
  app.commands.executeCommandById('graph:open');
  let view = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    view = app.workspace.getLeavesOfType('graph')[0]?.view ?? null;
    if (view?.presenter?.engine?.model) break;
  }
  const e = view.presenter.engine;
  const c = e.camera;
  await sleep(1500);

  const fit = (pad) => {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let i = 0; i < e.model.nodeCount; i++) {
      const x = e.pos[i * 2], y = e.pos[i * 2 + 1];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
    const zoom = Math.min(c.width / (maxx - minx + pad), c.height / (maxy - miny + pad));
    c.zoom = zoom;
    c.targetZoom = zoom;
    c.panX = c.width / 2 - ((minx + maxx) / 2) * zoom;
    c.panY = c.height / 2 - ((miny + maxy) / 2) * zoom;
    e.needsPaint = true;
    e.wake();
    return zoom;
  };

  const shots = {};
  const grab = async (name) => {
    await sleep(500);
    const url = e.screenshot();
    if (url) {
      const key = '__shot_' + name;
      window[key] = url;
      shots[name] = url.length;
    } else shots[name] = null;
  };

  const zoom = fit(240);
  await grab('fit');

  // close-up: centre on the biggest cluster and zoom so its disc is ~90 px
  let idx = 0, best = -1;
  for (let i = 0; i < e.model.nodeCount; i++) {
    if (e.model.kind[i] === 4) {
      const f = e.model.clusters[e.model.clusterId[i]].fileCount;
      if (f > best) { best = f; idx = i; }
    }
  }
  const wx = e.pos[idx * 2], wy = e.pos[idx * 2 + 1];
  const z2 = 90 / Math.max(4, e.radii[idx]);
  c.zoom = z2; c.targetZoom = z2;
  c.panX = c.width / 2 - wx * z2;
  c.panY = c.height / 2 - wy * z2;
  e.needsPaint = true; e.wake();
  await grab('closeup');

  return JSON.stringify({
    fitZoom: Math.round(zoom * 1000) / 1000,
    closeupZoom: Math.round(z2 * 1000) / 1000,
    cluster: e.model.label[idx],
    clusterRadiusPx: Math.round(e.radii[idx]),
    shots,
    status: view.contentEl.querySelector('.fast-graph-status')?.textContent,
  }, null, 1);
})()
