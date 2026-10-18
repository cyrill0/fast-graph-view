(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__errs = [];
  if (!window.__hooked) {
    window.__hooked = true;
    window.addEventListener('error', (e) => window.__errs.push('error: ' + e.message + ' @' + e.filename + ':' + e.lineno + ':' + e.colno + '\n' + (e.error?.stack ?? '')));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason?.stack ?? e.reason)));
    const origError = console.error.bind(console);
    console.error = (...a) => { window.__errs.push('console.error: ' + a.map((x) => (x && x.stack) || String(x)).join(' | ')); origError(...a); };
    const origWarn = console.warn.bind(console);
    console.warn = (...a) => { window.__errs.push('console.warn: ' + a.map(String).join(' | ')); origWarn(...a); };
  }

  // close any existing graph leaf, then reopen from scratch
  app.workspace.detachLeavesOfType('graph');
  await sleep(500);
  app.commands.executeCommandById('graph:open');
  let view = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    view = app.workspace.getLeavesOfType('graph')[0]?.view ?? null;
    if (view?.contentEl?.querySelector('.fast-graph-gl')) break;
  }
  const engine = view.presenter.engine;
  const r = engine.renderer;

  const trail = [];
  let prev = r.framesRendered;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const now = r.framesRendered;
    trail.push({ t: ((i + 1) * 0.5).toFixed(1), fps: Math.round(((now - prev) * 2) / 1), frames: now, running: engine.running, raf: engine.raf, alpha: Math.round(engine.alpha * 1e4) / 1e4 });
    prev = now;
  }
  return JSON.stringify({ trail, errors: window.__errs.slice(0, 12) }, null, 1);
})()
