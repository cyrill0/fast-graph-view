(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!app.plugins.getPlugin('fast-graph')) { await app.plugins.enablePlugin('fast-graph'); await sleep(900); }
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
  const host = view.presenter;
  const c = e.camera;
  await sleep(2500);

  // fit so every node is on screen
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (let i = 0; i < e.model.nodeCount; i++) {
    const x = e.pos[i * 2], y = e.pos[i * 2 + 1];
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const zoom = Math.min(c.width / (maxx - minx + 300), c.height / (maxy - miny + 300));
  c.zoom = zoom; c.targetZoom = zoom;
  c.panX = c.width / 2 - ((minx + maxx) / 2) * zoom;
  c.panY = c.height / 2 - ((miny + maxy) / 2) * zoom;
  e.needsPaint = true; e.wake();
  await sleep(700);

  const canvas = view.contentEl.querySelector('.fast-graph-gl');
  const box = canvas.getBoundingClientRect();
  // biggest cluster
  let idx = -1, best = -1;
  for (let i = 0; i < e.model.nodeCount; i++) {
    if (e.model.kind[i] !== 4) continue;
    const f = e.model.clusters[e.model.clusterId[i]].fileCount;
    if (f > best) { best = f; idx = i; }
  }
  const folder = e.model.path[idx];
  const sx = e.camera.worldToScreenX(e.pos[idx * 2]);
  const sy = e.camera.worldToScreenY(e.pos[idx * 2 + 1]);
  const at = { x: box.left + sx, y: box.top + sy };

  const log = [];
  const origClick = host.onNodeClick.bind(host);
  host.onNodeClick = (n, ev) => { log.push('click kind=' + n.kind + ' path=' + n.path); origClick(n, ev); };
  const origCtx = host.onNodeContext.bind(host);
  host.onNodeContext = (n, ev) => { log.push('context kind=' + n.kind + ' path=' + n.path); origCtx(n, ev); };

  const snap = () => ({ nodes: e.model.nodeCount, shownFiles: e.model.stats.shownFiles, folded: e.model.stats.collapsedFiles, revealed: e.revealedCount(folder) });
  const report = { folder, label: e.model.label[idx], hit: e.hitTest(sx, sy) === idx, before: snap() };

  const fire = (type, opts) => canvas.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: 21, isPrimary: true, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }, opts)));
  fire('pointerdown', { button: 0, buttons: 1 });
  report.dragNodeAfterDown = e.dragNode;
  fire('pointerup', { button: 0, buttons: 0 });
  await sleep(1200);
  report.afterClick = snap();

  canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }));
  await sleep(1200);
  report.afterContext = snap();

  report.log = log;
  report.status = view.contentEl.querySelector('.fast-graph-status')?.textContent;
  host.onNodeClick = origClick;
  host.onNodeContext = origCtx;
  return JSON.stringify(report, null, 1);
})()
