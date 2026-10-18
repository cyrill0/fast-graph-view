// Why does dragging a node on a settled layout not reheat the simulation?
// Pins the driver state, reheats through driver.pin() directly, then compares with a real drag.

const SHIM_ON = `(() => {
  if (window.__realRaf) return 'already shimmed';
  window.__realRaf = window.requestAnimationFrame.bind(window);
  window.__cancelReal = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (h) => clearTimeout(h);
  return 'shimmed';
})()`;

export default async function ({ evalJs, mouse, sleep }) {
  const out = {};
  const log = (l, v) => process.stderr.write(`[drag] ${l} ${JSON.stringify(v ?? null).slice(0, 220)}\n`);
  const ENG = `window.app.workspace.getLeavesOfType('graph')[0].view.presenter.engine`;

  log('shim', await evalJs(SHIM_ON));
  await evalJs(`(() => {
    const e = ${ENG};
    if (!e.__countsPaint) {
      e.__countsPaint = true;
      e.__painted = 0;
      const orig = e.paint.bind(e);
      e.paint = () => { e.__painted++; orig(); };
    }
    return 1;
  })()`);
  await evalJs(`(() => { const e = ${ENG}; e.running = false; e.raf = 0; e.idleFrames = 0; e.wake(); return 1; })()`);
  await sleep(2000);

  out.driverState = JSON.parse(
    await evalJs(`JSON.stringify((() => {
      const e = ${ENG};
      const d = e.driver;
      return {
        running: e.running, alpha: e.alpha, painted: e.__painted ?? null,
        hasWorker: !!d.worker, hasInline: !!d.inline, revision: d.revision,
        driverAlpha: d.alpha ?? null, destroyed: d.destroyed,
      };
    })())`),
  );
  log('driverState', out.driverState);

  const target = JSON.parse(
    await evalJs(`(function () {
      const e = ${ENG};
      const b = window.app.workspace.getLeavesOfType('graph')[0].view.contentEl.querySelector('.fast-graph-gl').getBoundingClientRect();
      for (let i = 0; i < e.model.nodeCount; i++) {
        const x = e.camera.worldToScreenX(e.pos[i * 2]), y = e.camera.worldToScreenY(e.pos[i * 2 + 1]);
        if (x < 60 || y < 60 || x > b.width - 120 || y > b.height - 120) continue;
        if (e.hitTest(x, y) !== i) continue;
        return JSON.stringify({ i, x: Math.round(b.left + x), y: Math.round(b.top + y), wx: e.pos[i * 2], wy: e.pos[i * 2 + 1] });
      }
      return JSON.stringify(null);
    })()`),
  );
  out.target = target;
  log('target', target);
  if (!target) return out;

  // A: reheat straight through the driver, no input events involved
  await evalJs(`(() => { const e = ${ENG}; e.__painted = 0; e.driver.pin(${target.i}, ${target.wx + 120}, ${target.wy + 120}, 0.3); return 1; })()`);
  const traceA = [];
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    traceA.push(
      JSON.parse(
        await evalJs(`JSON.stringify((() => { const e = ${ENG}; return { alpha: Math.round(e.alpha * 1e4) / 1e4, painted: e.__painted, running: e.running, x: Math.round(e.pos[${target.i} * 2]), y: Math.round(e.pos[${target.i} * 2 + 1]) }; })())`),
      ),
    );
  }
  out.driverPin = traceA;
  log('driverPin', traceA.slice(-2));
  await evalJs(`(() => { const e = ${ENG}; e.driver.unpin(${target.i}); return 1; })()`);
  await sleep(2500);

  // B: the same thing through trusted pointer events
  await evalJs(`(() => { const e = ${ENG}; e.__painted = 0; return 1; })()`);
  const live = JSON.parse(
    await evalJs(`(function(){ const e = ${ENG}; const b = window.app.workspace.getLeavesOfType('graph')[0].view.contentEl.querySelector('.fast-graph-gl').getBoundingClientRect(); return JSON.stringify({ x: Math.round(b.left + e.camera.worldToScreenX(e.pos[${target.i} * 2])), y: Math.round(b.top + e.camera.worldToScreenY(e.pos[${target.i} * 2 + 1])) }); })()`),
  );
  await mouse('move', live.x, live.y, { waitMs: 120 });
  await mouse('down', live.x, live.y, { waitMs: 60 });
  out.pointerDown = JSON.parse(
    await evalJs(`JSON.stringify((() => { const e = ${ENG}; return { dragNode: e.dragNode, panning: e.panning, alpha: Math.round(e.alpha * 1e4) / 1e4, running: e.running, painted: e.__painted }; })())`),
  );
  log('pointerDown', out.pointerDown);
  const traceB = [];
  for (let i = 1; i <= 6; i++) {
    await mouse('move', live.x + i * 14, live.y + i * 10, { waitMs: 60 });
    traceB.push(
      JSON.parse(
        await evalJs(`JSON.stringify((() => { const e = ${ENG}; return { dragNode: e.dragNode, alpha: Math.round(e.alpha * 1e4) / 1e4, painted: e.__painted, x: Math.round(e.pos[${target.i} * 2]), needsPaint: e.needsPaint }; })())`),
      ),
    );
  }
  out.pointerDrag = traceB;
  log('pointerDrag', traceB.slice(-2));
  await mouse('up', live.x + 90, live.y + 66, { waitMs: 60 });
  await sleep(1500);
  out.afterRelease = JSON.parse(
    await evalJs(`JSON.stringify((() => { const e = ${ENG}; return { dragNode: e.dragNode, alpha: Math.round(e.alpha * 1e4) / 1e4, painted: e.__painted, running: e.running }; })())`),
  );
  log('afterRelease', out.afterRelease);
  out.openedFile = await evalJs(`window.app.workspace.getActiveFile()?.path ?? null`);
  return out;
}
