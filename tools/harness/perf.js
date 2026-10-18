(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = () => document.visibilityState + (document.hasFocus() ? '+focused' : '+unfocused');

  let view = app.workspace.getLeavesOfType('graph')[0]?.view ?? null;
  if (!view?.contentEl?.querySelector('.fast-graph-gl')) {
    app.commands.executeCommandById('graph:open');
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      view = app.workspace.getLeavesOfType('graph')[0]?.view ?? null;
      if (view?.contentEl?.querySelector('.fast-graph-gl')) break;
    }
  }
  if (!view) return JSON.stringify({ error: 'no graph view' });
  const engine = view.presenter.engine;
  const renderer = engine.renderer;
  const gl = renderer.gl;
  const canvas = view.contentEl.querySelector('.fast-graph-gl');

  const head = {
    visibility: vis(),
    window: window.innerWidth + 'x' + window.innerHeight + ' dpr=' + window.devicePixelRatio,
    gl2: gl instanceof WebGL2RenderingContext,
    renderer: gl.getParameter(gl.VERSION) + ' | ' + gl.getParameter(gl.RENDERER),
    workerPhysics: engine.driver.usingWorker,
    nodes: engine.model?.nodeCount,
    edges: engine.model?.edgeCount,
    buildMs: Math.round(engine.lastBuildMs * 10) / 10,
  };

  const frames = async (ms) => {
    const a = renderer.framesRendered;
    const t = performance.now();
    await sleep(ms);
    return ((renderer.framesRendered - a) * 1000) / (performance.now() - t);
  };

  // A) frame rate while the force layout is still hot
  engine.driver.reheat?.();
  const hot = Math.round((await frames(2000)) * 10) / 10;

  // B) true per-frame cost, GPU included
  const timed = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    engine.paint();
    gl.finish();
    timed.push(performance.now() - t0);
    await sleep(8);
  }
  timed.sort((x, y) => x - y);
  const pct = (p) => Math.round(timed[Math.floor(p * (timed.length - 1))] * 1000) / 1000;

  // C) frame rate while panning + zooming with real pointer events
  const r = canvas.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const wheel = (dy, x) =>
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: x ?? cx, clientY: cy, bubbles: true, cancelable: true }));
  let wheelCount = 0;
  const panFrames = (async () => {
    for (let i = 0; i < 24; i++) {
      wheel(i % 2 ? 60 : -60, cx + Math.sin(i / 2) * 120);
      wheelCount++;
      await sleep(70);
    }
  })();
  const interacting = Math.round((await frames(1700)) * 10) / 10;
  await panFrames;

  const drag = await (async () => {
    const before = { x: engine.camera.state().x, y: engine.camera.state().y };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, buttons: 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true, isPrimary: true }));
    for (let i = 1; i <= 12; i++) {
      canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, button: -1, buttons: 1, clientX: cx + i * 12, clientY: cy + i * 6, bubbles: true, isPrimary: true }));
      await sleep(16);
    }
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, buttons: 0, clientX: cx + 144, clientY: cy + 72, bubbles: true, isPrimary: true }));
    await sleep(120);
    const after = engine.camera.state();
    return {
      movedX: Math.round(after.x - before.x),
      movedY: Math.round(after.y - before.y),
      grabbing: view.contentEl.hasClass('is-grabbing'),
    };
  })();

  return JSON.stringify({
    head,
    hotLayoutFps: hot,
    paintGpuMs: { p10: pct(0.1), median: pct(0.5), p90: pct(0.9), max: pct(1) },
    interactionFps: interacting,
    wheelEvents: wheelCount,
    drag,
    tailVisibility: vis(),
    status: view.contentEl.querySelector('.fast-graph-status')?.textContent ?? null,
    zoom: Math.round(engine.camera.zoom * 1000) / 1000,
  }, null, 1);
})()
