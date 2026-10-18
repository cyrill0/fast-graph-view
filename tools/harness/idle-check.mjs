// Moves the real pointer off the canvas, then asks why the render loop will not go idle.
import fs from 'node:fs';

export default async function ({ evalJs, mouse, sleep }) {
  const out = {};
  await mouse('move', 120, 300, { waitMs: 200 });
  await mouse('move', 60, 620, { waitMs: 400 });
  await sleep(1500);
  out.pointerState = await evalJs(`(() => { const e = window.app.workspace.getLeavesOfType('graph')[0].view.presenter.engine; return JSON.stringify({running: e.running, alpha: e.alpha, idleFrames: e.idleFrames, pointerActive: e.pointerActive, hoverNode: e.hoverNode}); })()`);
  await sleep(1000);
  out.afterQuiet = await evalJs(`(() => { const e = window.app.workspace.getLeavesOfType('graph')[0].view.presenter.engine; return JSON.stringify({running: e.running, alpha: e.alpha, idleFrames: e.idleFrames}); })()`);
  const probe = fs.readFileSync(new URL('./idle-probe.js', import.meta.url), 'utf8');
  out.probe = JSON.parse(await evalJs(`(${probe})`));
  return out;
}
