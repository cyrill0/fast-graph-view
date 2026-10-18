(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CLUSTER = 4;

  app.workspace.detachLeavesOfType('graph');
  await sleep(300);
  app.commands.executeCommandById('graph:open');
  let view = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    view = app.workspace.getLeavesOfType('graph')[0]?.view ?? null;
    if (view?.presenter?.engine?.model) break;
  }
  const e = view.presenter.engine;
  const canvas = view.contentEl.querySelector('.fast-graph-gl');
  const box = canvas.getBoundingClientRect();
  const model = e.model;

  // the biggest folded folder that is actually on screen
  let idx = -1;
  let best = -1;
  for (let i = 0; i < model.nodeCount; i++) {
    if (model.kind[i] !== CLUSTER) continue;
    const x = e.camera.worldToScreenX(e.pos[i * 2]);
    const y = e.camera.worldToScreenY(e.pos[i * 2 + 1]);
    if (x < 40 || y < 40 || x > box.width - 40 || y > box.height - 40) continue;
    const count = model.clusters?.[model.clusterId?.[i]]?.fileCount ?? 0;
    if (count > best) { best = count; idx = i; }
  }
  if (idx < 0) return JSON.stringify({ error: 'no visible cluster node', clusters: model.clusters?.length });

  const meta = model.clusters[model.clusterId[idx]];
  const at = {
    x: box.left + e.camera.worldToScreenX(e.pos[idx * 2]),
    y: box.top + e.camera.worldToScreenY(e.pos[idx * 2 + 1]),
  };
  const local = { x: at.x - box.left, y: at.y - box.top };

  const pointer = (type, opts) =>
    canvas.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }, opts)));

  const snap = () => ({
    nodes: e.model.nodeCount,
    edges: e.model.edgeCount,
    revealed: e.revealedCount(meta.folder),
    status: view.contentEl.querySelector('.fast-graph-status')?.textContent ?? null,
  });

  const report = { folder: meta.folder, fileCount: meta.fileCount, label: meta.label, hitTest: e.hitTest(local.x, local.y) === idx };
  report.before = snap();

  // hover -> metadata card
  pointer('pointermove', {});
  await sleep(180);
  const card = view.contentEl.querySelector('.fast-graph-card');
  report.hoverCard = card ? card.innerText.replace(/\n+/g, ' | ').slice(0, 400) : null;

  // left click -> reveal REVEAL_STEP notes of that folder
  pointer('pointerdown', { button: 0, buttons: 1 });
  pointer('pointerup', { button: 0, buttons: 0 });
  await sleep(900);
  report.afterClick = snap();

  // right click -> fold the folder back up
  canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }));
  await sleep(900);
  report.afterContext = snap();

  // clicking a plain file node opens the note
  let fileIdx = -1;
  for (let i = 0; i < e.model.nodeCount; i++) {
    if (e.model.kind[i] !== 0) continue;
    const x = e.camera.worldToScreenX(e.pos[i * 2]);
    const y = e.camera.worldToScreenY(e.pos[i * 2 + 1]);
    if (x < 40 || y < 40 || x > box.width - 40 || y > box.height - 40) continue;
    fileIdx = i;
    break;
  }
  if (fileIdx >= 0) {
    const p = {
      x: box.left + e.camera.worldToScreenX(e.pos[fileIdx * 2]),
      y: box.top + e.camera.worldToScreenY(e.pos[fileIdx * 2 + 1]),
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, isPrimary: true, bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 8, isPrimary: true, bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons: 0 }));
    await sleep(700);
    const active = app.workspace.getActiveFile();
    report.fileClick = { path: active?.path ?? null, expected: e.model.path?.[fileIdx] ?? null, leaves: app.workspace.getLeavesOfType('markdown').length };
  }

  // and a file context menu
  if (fileIdx >= 0) {
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }));
    await sleep(200);
    const menu = document.querySelector('.menu');
    report.contextMenu = menu ? [...menu.querySelectorAll('.menu-item')].map((i) => i.querySelector('.menu-item-title')?.textContent ?? '?') : null;
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  }
  return JSON.stringify(report, null, 1);
})()
