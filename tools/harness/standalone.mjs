// Standalone registration and teardown smoke scenario for a running Obsidian instance.

const INSTRUMENT = `(() => {
  window.__fgvErrors ??= [];
  if (!window.__fgvErrorHook) {
    window.__fgvErrorHook = true;
    addEventListener('error', (event) => window.__fgvErrors.push(event.message));
    addEventListener('unhandledrejection', (event) => window.__fgvErrors.push(String(event.reason)));
  }
  if (!window.__fgvWorkers && window.Worker) {
    const NativeWorker = window.Worker;
    window.__fgvWorkers = { created: 0, terminated: 0 };
    function TrackedWorker(url, options) {
      const worker = new NativeWorker(url, options);
      window.__fgvWorkers.created++;
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        window.__fgvWorkers.terminated++;
        return terminate();
      };
      return worker;
    }
    TrackedWorker.prototype = NativeWorker.prototype;
    window.Worker = TrackedWorker;
  }
  return true;
})()`;

const SNAPSHOT = `(() => JSON.stringify({
  enabled: !!window.app.plugins.getPlugin('fast-graph-view'),
  globalLeaves: window.app.workspace.getLeavesOfType('fast-graph-view').length,
  localLeaves: window.app.workspace.getLeavesOfType('fast-localgraph').length,
  nativeGlobalLeaves: window.app.workspace.getLeavesOfType('graph').length,
  nativeLocalLeaves: window.app.workspace.getLeavesOfType('localgraph').length,
  canvases: document.querySelectorAll('canvas.fast-graph-gl').length,
  workers: window.__fgvWorkers ?? { created: 0, terminated: 0 },
  errors: window.__fgvErrors ?? [],
}))()`;

export default async function ({ evalJs, sleep, wake, raise }) {
  await wake();
  await raise();
  await evalJs(INSTRUMENT);

  const before = JSON.parse(await evalJs(SNAPSHOT));
  await evalJs(`window.app.commands.executeCommandById('fast-graph-view:open')`);
  await sleep(1500);
  const opened = JSON.parse(await evalJs(SNAPSHOT));

  if (opened.globalLeaves < 1 || opened.canvases < 1) {
    throw new Error(`Standalone graph did not open: ${JSON.stringify(opened)}`);
  }
  await evalJs(`window.app.plugins.disablePlugin('fast-graph-view')`);
  await sleep(750);
  const disabled = JSON.parse(await evalJs(SNAPSHOT));
  if (disabled.canvases !== 0) throw new Error(`Canvas leaked after disable: ${JSON.stringify(disabled)}`);
  if (disabled.workers.terminated < opened.workers.created) {
    throw new Error(`Worker leaked after disable: ${JSON.stringify(disabled.workers)}`);
  }
  if (disabled.errors.length) throw new Error(`Renderer errors: ${disabled.errors.join(' | ')}`);

  await evalJs(`window.app.plugins.enablePlugin('fast-graph-view')`);
  await sleep(750);
  const reenabled = JSON.parse(await evalJs(SNAPSHOT));

  return { before, opened, disabled, reenabled };
}
