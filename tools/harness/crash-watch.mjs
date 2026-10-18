// Does the webview reload on its own, or only under harness input?
//
// A localStorage journal outlives the reload, so after the page comes back we can read when
// the previous document last ticked and which teardown events it saw before it died.

const KEY = 'fgWatch';

const INSTALL = `(() => {
  const W = { born: Math.round(performance.now()), ticks: [], events: [], nodes: null };
  const save = () => { try { localStorage.setItem('${KEY}', JSON.stringify(W)); } catch (e) {} };
  const push = (t, detail) => { W.events.push([t, Math.round(performance.now()), detail]); save(); };
  window.__w = W;
  window.__wPush = push;
  try { const prev = localStorage.getItem('${KEY}'); if (prev) localStorage.setItem('${KEY}Prev', prev); } catch (e) {}
  for (const t of ['beforeunload', 'unload', 'pagehide']) {
    window.addEventListener(t, () => push(t, document.visibilityState), { capture: true });
  }
  document.addEventListener('visibilitychange', () => push('visibilitychange', document.visibilityState), { capture: true });
  window.addEventListener('error', (e) => push('error', (e.message || '') + ' @' + (e.filename || '') + ':' + e.lineno), true);
  window.addEventListener('unhandledrejection', (e) => push('rejection', String((e.reason && e.reason.message) || e.reason)), true);
  const cv = document.querySelector('.fast-graph-gl');
  if (cv) cv.addEventListener('webglcontextlost', (e) => push('webglcontextlost', e.statusMessage || ''), false);
  W.nodes = engine()?.model?.nodeCount ?? null;
  setInterval(() => { W.ticks.push(Math.round(performance.now())); if (W.ticks.length > 400) W.ticks.shift(); save(); }, 2000);
  save();
  return JSON.stringify({ born: W.born, previousEvents: (() => { try { return JSON.parse(localStorage.getItem('${KEY}'))?.events?.length ?? 0; } catch (e) { return -1; } })() });
})()`;

const PRELUDE = `(() => {
  const app = window.app;
  window.__engine = () => app.workspace.getLeavesOfType('graph')[0]?.view?.presenter?.engine ?? null;
  window.__canvas = () => app.workspace.getLeavesOfType('graph')[0]?.view?.contentEl.querySelector('.fast-graph-gl');
  return 1;
})()`;

const STATE = `JSON.stringify((function () {
  const e = window.__engine();
  return { born: Math.round(performance.now()), alpha: e?.alpha ?? null, running: e?.running ?? null, nodes: e?.model?.nodeCount ?? null };
})())`;

const READ = `(() => {
  const raw = localStorage.getItem('${KEY}');
  if (!raw) return 'no journal';
  const w = JSON.parse(raw);
  return JSON.stringify({
    journalBorn: w.born,
    lastTick: w.ticks[w.ticks.length - 1] ?? null,
    tickCount: w.ticks.length,
    events: w.events,
    journalNodes: w.nodes,
    clockNow: Math.round(performance.now()),
    navType: performance.getEntriesByType('navigation')[0]?.type ?? null,
    liveNodes: window.__engine?.()?.model?.nodeCount ?? null,
    previousPage: (() => { try { const p = JSON.parse(localStorage.getItem('${KEY}Prev')); return p ? { born: p.born, lastTick: p.ticks[p.ticks.length - 1] ?? null, events: p.events } : null; } catch (e) { return 'unreadable'; } })(),
  });
})()`;

export default async function ({ evalJs, mouse, sleep }) {
  const out = {};
  const step = async (name, fn) => {
    try {
      out[name] = await fn();
      console.error(`[watch] ${name} ${String(JSON.stringify(out[name])).slice(0, 320)}`);
      return out[name];
    } catch (e) {
      out[name] = { failed: String(e.message ?? e) };
      console.error(`[watch] ${name} FAILED ${e.message}`);
      return out[name];
    }
  };

  await step('prelude', () => evalJs(PRELUDE));
  await step('journalBefore', () => evalJs(READ));
  const installed = await step('install', () =>
    evalJs(`${PRELUDE}; ${INSTALL.replace('engine()', 'window.__engine()')}`),
  );
  const born = installed?.born ?? null;
  await step('state', () => evalJs(STATE));

  const aim = await step('aimCluster', () =>
    evalJs(`(function () {
      const e = window.__engine();
      const cv = window.__canvas();
      const b = cv.getBoundingClientRect();
      for (let i = 0; i < e.model.nodeCount; i++) {
        if (e.model.kind[i] !== 4) continue;
        const x = Math.round(e.camera.worldToScreenX(e.pos[i * 2]));
        const y = Math.round(e.camera.worldToScreenY(e.pos[i * 2 + 1]));
        if (x < 24 || y < 24 || x > b.width - 24 || y > b.height - 24) continue;
        if (e.hitTest(x, y) !== i) continue;
        if (document.elementFromPoint(b.left + x, b.top + y) !== cv) continue;
        return JSON.stringify({ i, x: Math.round(b.left + x), y: Math.round(b.top + y), folder: e.model.path[i] });
      }
      return null;
    })()`).then((s) => (s ? JSON.parse(s) : null)),
  );

  if (aim) {
    await step('clusterClick', async () => {
      await mouse('move', aim.x, aim.y, { waitMs: 200 });
      await mouse('click', aim.x, aim.y, { waitMs: 1500 });
      return evalJs(STATE);
    });
  } else {
    await step('clusterClick', () => 'skipped - no hittable cluster');
  }

  // unattended idle: a reload here happens with no input at all
  let reloaded = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const s = await step(`idle${i}`, () => evalJs(STATE).then((v) => JSON.parse(v)));
    if (s?.failed) { reloaded = `poll ${i}: eval failed`; break; }
    if (born !== null && s.born < born) { reloaded = `poll ${i}: page reloaded (clock ${s.born} < born ${born})`; break; }
  }
  out.reloaded = reloaded ?? 'no reload during 60 s of unattended idle';
  console.error(`[watch] reloaded ${JSON.stringify(out.reloaded)}`);

  await step('journalAfter', () => evalJs(READ));
  return out;
}
