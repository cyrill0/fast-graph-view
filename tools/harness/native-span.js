(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  app.workspace.detachLeavesOfType('graph');
  await sleep(300);
  await app.plugins.disablePlugin('fast-graph-view');
  await sleep(600);

  const core = app.internalPlugins.getPluginById('graph').instance;
  core.options.scale = 1;
  core.saveOptions();

  app.commands.executeCommandById('graph:open');
  let view = null;
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    view = app.workspace.getLeavesOfType('graph')[0]?.view ?? null;
    if (view?.contentEl?.querySelector('canvas')) break;
  }
  out.opened = !!view;
  out.viewKeys = view ? Object.keys(view).concat(Object.keys(view.renderer ?? {})).slice(0, 40) : null;

  // let the layout run
  await sleep(9000);

  const r = view.renderer;
  const findArrays = (obj, depth, path, acc) => {
    if (!obj || depth > 2 || acc.length > 14) return acc;
    for (const k of Object.keys(obj)) {
      let v;
      try { v = obj[k]; } catch { continue; }
      if (Array.isArray(v) && v.length > 500) acc.push(path + k + ':array(' + v.length + ')');
      else if (v && typeof v === 'object' && v.nodes && typeof v.nodes === 'function') acc.push(path + k + ':hasNodes()');
      else if (v && typeof v === 'object' && depth < 2) findArrays(v, depth + 1, path + k + '.', acc);
    }
    return acc;
  };
  out.candidates = findArrays(r, 0, 'renderer.', []);

  let nodes = null;
  for (const key of ['simulator', 'simulation', 'graph', 'renderer']) {
    const cand = r?.[key] ?? view?.[key];
    if (cand && typeof cand.nodes === 'function') { nodes = cand.nodes(); out.via = key; break; }
  }
  if (!nodes && r?.simulator?.sim) { nodes = r.simulator.sim.nodes(); out.via = 'r.simulator.sim'; }
  if (Array.isArray(nodes) && nodes.length) {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const n of nodes) {
      if (typeof n.x !== 'number') continue;
      minx = Math.min(minx, n.x); maxx = Math.max(maxx, n.x);
      miny = Math.min(miny, n.y); maxy = Math.max(maxy, n.y);
    }
    out.native = {
      count: nodes.length,
      spanX: Math.round(maxx - minx),
      spanY: Math.round(maxy - miny),
      sample: nodes.slice(0, 3).map((n) => ({ x: Math.round(n.x), y: Math.round(n.y), r: n.r ?? n.radius ?? null, val: n.val ?? n.size ?? null })),
      scale: core.options.scale,
    };
  } else {
    out.native = { count: null, note: 'positions not reachable' };
  }
  window.__nativeShot = null;
  out.status = view.contentEl.querySelector('.fast-graph-status')?.textContent ?? null;
  out.canvas = (() => { const c = view.contentEl.querySelector('canvas'); const b = c.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); })();
  return JSON.stringify(out, null, 1);
})()
