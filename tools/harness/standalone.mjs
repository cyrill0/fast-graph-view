// Standalone (non-takeover) mode + teardown scenario.
//
// Two questions this answers with measurements instead of reading code:
//  1. with takeover off, does the built-in graph view come back completely (creators,
//     ribbon, commands, hover source) while our own view types still open;
//  2. does closing/disabling the plugin give everything back - blob worker terminated,
//     window listeners balanced, canvases gone, and a re-enable that renders again.
//
// Instrumentation is installed before the first open, so it counts the very listeners and
// workers the plugin creates rather than leftovers from an earlier session.

const FRAME_SOURCE = `(async () => {
  const windows = [];
  for (let w = 0; w < 2; w++) {
    let n = 0;
    const t0 = performance.now();
    requestAnimationFrame(function loop() { n++; if (performance.now() - t0 < 500) requestAnimationFrame(loop); });
    await new Promise((r) => setTimeout(r, 650));
    windows.push(n);
  }
  return JSON.stringify({ framesPer500ms: windows, visibility: document.visibilityState, hasFocus: document.hasFocus() });
})()`;

// Wrap window listeners and the Worker constructor, and keep a per-engine census.
const INSTRUMENT = `(() => {
  if (!window.__errs) {
    window.__errs = [];
    addEventListener('error', (ev) => window.__errs.push('error: ' + ev.message + ' @' + ev.filename + ':' + ev.lineno));
    addEventListener('unhandledrejection', (ev) => window.__errs.push('reject: ' + String(ev.reason).slice(0, 200)));
    const orig = console.error.bind(console);
    console.error = (...a) => { window.__errs.push('console: ' + a.map(String).join(' ').slice(0, 200)); orig(...a); };
  }
  if (!window.__lk) {
    window.__lk = { add: {}, rem: {}, live: new Map() };
    const add = window.addEventListener.bind(window);
    const rem = window.removeEventListener.bind(window);
    const site = () => (new Error().stack || '').split('\\n').slice(2, 5).map((s) => s.trim()).join(' <- ').slice(0, 260);
    window.addEventListener = function (type, fn, ...rest) {
      window.__lk.add[type] = (window.__lk.add[type] ?? 0) + 1;
      if (fn) {
        const rec = window.__lk.live.get(fn) ?? [];
        rec.push({ type, head: String(fn).slice(0, 70), stack: site() });
        window.__lk.live.set(fn, rec);
      }
      return add(type, fn, ...rest);
    };
    window.removeEventListener = function (type, fn, ...rest) {
      window.__lk.rem[type] = (window.__lk.rem[type] ?? 0) + 1;
      const rec = window.__lk.live.get(fn);
      if (rec) {
        const i = rec.findIndex((r) => r.type === type);
        if (i >= 0) rec.splice(i, 1);
        if (!rec.length) window.__lk.live.delete(fn);
      }
      return rem(type, fn, ...rest);
    };
  }
  if (!window.__wk && window.Worker) {
    const Native = window.Worker;
    const siteOf = () => (new Error().stack || '').split('\\n').slice(2, 5).map((s) => s.trim()).join(' <- ').slice(0, 260);
    window.__wk = { created: 0, terminated: 0, refs: [], sites: [] };
    function Wrapped(url, o) {
      const w = new Native(url, o);
      window.__wk.created++;
      window.__wk.sites.push({ url: String(url).slice(0, 40), stack: siteOf(), alive: true });
      const site = window.__wk.sites[window.__wk.sites.length - 1];
      window.__wk.refs.push(w);
      const terminate = w.terminate.bind(w);
      w.terminate = function () {
        window.__wk.terminated++;
        site.alive = false;
        return terminate();
      };
      return w;
    }
    Wrapped.prototype = Native.prototype;
    window.Worker = Wrapped;
  }
  return 1;
})()`;

const SNAP = `(() => {
  const app = window.app;
  const p = app.plugins.getPlugin('fast-graph-view');
  const reg = app.viewRegistry ?? null;
  const ours = (leaf) => !!(leaf?.view?.presenter);
  const byType = (t) => app.workspace.getLeavesOfType(t);
  return JSON.stringify({
    takeover: p?.settings?.takeover ?? null,
    clusterLocalGraphs: p?.settings?.clusterLocalGraphs ?? null,
    threshold: p?.settings?.cluster?.threshold ?? null,
    globalType: p?.globalType ?? null,
    localType: p?.localType ?? null,
    hoverSource: p?.hoverSource ?? null,
    managed: (p?.managed ?? []).map((s) => ({ type: s.type, standalone: !!s.standalone, hadPrevious: !!s.previous })),
    commandIds: (p?.commands ?? []).map((c) => c.commandId ?? c.id ?? null),
    coreGraphEnabled: !!app.internalPlugins?.getEnabledPluginById('graph'),
    creators: ['graph', 'localgraph', 'fast-graph-view', 'fast-localgraph'].reduce((acc, t) => {
      acc[t] = !!(reg?.getViewCreatorByType?.(t) ?? reg?.viewByType?.[t]);
      return acc;
    }, {}),
    leaves: {
      graph: byType('graph').length,
      graphOurs: byType('graph').filter(ours).length,
      localgraph: byType('localgraph').length,
      localgraphOurs: byType('localgraph').filter(ours).length,
      standalone: byType('fast-graph-view').length,
      standaloneLocal: byType('fast-localgraph').length,
    },
    canvases: document.querySelectorAll('canvas.fast-graph-gl').length,
    ribbonGraphIcons: [...document.querySelectorAll('.side-dock-ribbon-item')].filter((el) =>
      el.querySelector('svg')?.outerHTML.includes('lucide-git-fork') || el.getAttribute('aria-label')?.toLowerCase().includes('graph'),
    ).map((el) => el.getAttribute('aria-label')),
    workers: { created: window.__wk?.created ?? null, terminated: window.__wk?.terminated ?? null },
  });
})()`;

export default async function ({ evalJs, mouse, key, sleep, shot, wake, raise }) {
  const out = {};
  const step = async (name, fn) => {
    try {
      out[name] = await fn();
      console.error(`[standalone] ${name} ${String(JSON.stringify(out[name])).slice(0, 320)}`);
    } catch (e) {
      out[name] = { failed: String(e.message ?? e) };
      console.error(`[standalone] ${name} FAILED ${e.message}`);
    }
    return out[name];
  };
  const json = (s) => (s ? JSON.parse(s) : null);
  const snap = () => evalJs(SNAP).then(json);
  /** rAF callbacks per second - 0 means the compositor stalled and no timing number here means anything. */
  const cadence = (ms = 1500) =>
    evalJs(`(async () => {
      const t0 = performance.now();
      let n = 0;
      await new Promise((r) => { setTimeout(r, ${ms}); requestAnimationFrame(function loop() { n++; if (performance.now() - t0 < ${ms}) requestAnimationFrame(loop); else r(); }); });
      return JSON.stringify({ frames: n, ms: Math.round(performance.now() - t0), fps: Math.round((n / (performance.now() - t0)) * 1000 * 10) / 10, vis: document.visibilityState, focus: document.hasFocus() });
    })()`).then(json);
  const waitEngine = async (type, budget = 20000) =>
    evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < ${budget} / 250; i++) {
        const l = window.app.workspace.getLeavesOfType(${JSON.stringify(type)})[0];
        if (l?.view?.presenter?.engine?.model) return 'ready after ' + (i * 250) + ' ms';
        await sleep(250);
      }
      return 'no engine after ' + ${budget} + ' ms';
    })()`);
  const setTakeover = (value) =>
    evalJs(`(async () => {
      const p = window.app.plugins.getPlugin('fast-graph-view');
      if (!p) return 'NO PLUGIN';
      p.settings.takeover = ${value};
      p.reRegister();
      // persist like the settings toggle does: disable saves, and an unsaved flip would
      // silently come back as the old mode on the next enable
      await p.saveData();
      await new Promise((r) => setTimeout(r, 1200));
      return JSON.stringify({ memory: p.settings.takeover, onDisk: (await p.loadData())?.takeover ?? null });
    })()`);

  await wake();
  await step('frameSource', () => evalJs(FRAME_SOURCE));
  await step('instrument', () => evalJs(INSTRUMENT));

  // baseline: takeover on, as the plugin ships
  out.takeoverBaseline = await step('takeoverBaseline', snap);

  // 1) standalone mode: the core view has to come back in every place we borrowed it
  await step('standaloneOn', () => setTakeover(false));
  await step('standaloneSnapshot', snap);
  await step('nativeGraphOpens', async () => {
    await evalJs(`(async () => {
      const app = window.app;
      app.workspace.detachLeavesOfType('graph');
      await new Promise((r) => setTimeout(r, 400));
      app.commands.executeCommandById('graph:open');
      await new Promise((r) => setTimeout(r, 1500));
    })()`);
    const leaf = await evalJs(`(() => {
      const l = window.app.workspace.getLeavesOfType('graph')[0] ?? null;
      return JSON.stringify({
        open: !!l,
        ours: !!(l?.view?.presenter),
        viewType: l?.view?.getViewType?.() ?? null,
        hasPixiRenderer: !!(l?.view?.renderer),
        nativeStatusText: l?.view?.contentEl?.querySelector('.graph-view') ? 'native canvas' : 'none',
      });
    })()`);
    return json(leaf);
  });
  await step('shotNativeGraph', () => shot('/tmp/shots/standalone-native-graph.png'));
  await step('ourCommandsStillWork', async () => {
    const r = json(
      await evalJs(`(() => {
        const app = window.app;
        const p = app.plugins.getPlugin('fast-graph-view');
        const pid = p?.manifest?.id ?? '';
        const raw = (p?.commands ?? []).map((c) => c.commandId ?? c.id ?? null);
        const table = {};
        for (const id of raw) {
          if (!id) continue;
          const bare = app.commands.commands[id];
          const namespaced = app.commands.commands[pid + ':' + id];
          table[id] = {
            bare: bare ? 'resolves' : null,
            namespaced: namespaced ? 'resolves' : null,
            enabled: (namespaced ?? bare) ? app.commands.checkCommand?.(pid + ':' + id) ?? true : null,
          };
        }
        return JSON.stringify({ pid, raw, table, palette: app.commands.listCommands().filter((c) => /clustered graph|timelapse|fast graph/i.test(c.name ?? '')).map((c) => ({ id: c.id, name: c.name })) });
      })()`),
    );
    return r;
  });
  await step('standaloneTypeOpens', async () => {
    const opened = json(await evalJs(`(async () => {
      const app = window.app;
      const leaf = app.workspace.getLeaf(false);
      await leaf.setViewState({ type: 'fast-graph-view', active: true, state: {} });
      await new Promise((r) => setTimeout(r, 400));
      return JSON.stringify({ requested: 'fast-graph-view', actualType: leaf.view?.getViewType?.() ?? null });
    })()`));
    const ready = await waitEngine('fast-graph-view');
    const info = json(
      await evalJs(`(() => {
        const l = window.app.workspace.getLeavesOfType('fast-graph-view')[0] ?? null;
        const e = l?.view?.presenter?.engine ?? null;
        return JSON.stringify({
          leavesOfType: window.app.workspace.getLeavesOfType('fast-graph-view').length,
          emptyLeaves: window.app.workspace.getLeavesOfType('empty').length,
          viewType: l?.view?.getViewType?.() ?? null,
          ours: !!(l?.view?.presenter),
          nodes: e?.model?.nodeCount ?? null,
          clusters: e?.model?.stats?.clusters ?? null,
          collapsedFiles: e?.model?.stats?.collapsedFiles ?? null,
          status: l?.view?.contentEl?.querySelector('.fast-graph-status')?.textContent ?? null,
        });
      })()`),
    );
    return { ...opened, ready, ...info };
  });
  await step('standaloneLocalOpens', async () => {
    const r = await evalJs(`(async () => {
      const app = window.app;
      const file = app.vault.getMarkdownFiles().find((f) => f.extension === 'md');
      const leaf = app.workspace.getLeaf('split');
      await leaf.setViewState({ type: 'markdown', active: true, state: { file: file.path } });
      await new Promise((r2) => setTimeout(r2, 500));
      const ok = app.commands.executeCommandById('fast-graph-view:open-local') || app.commands.executeCommandById('open-local');
      await new Promise((r2) => setTimeout(r2, 1600));
      const l = app.workspace.getLeavesOfType('fast-localgraph')[0] ?? null;
      return JSON.stringify({
        file: file.path,
        byId: ok,
        localLeaves: app.workspace.getLeavesOfType('fast-localgraph').length,
        viewType: l?.view?.getViewType?.() ?? null,
        ours: !!(l?.view?.presenter),
        nodes: l?.view?.presenter?.engine?.model?.nodeCount ?? null,
        root: l?.view?.presenter?.engine?.scopePath ?? null,
      });
    })()`);
    return json(r);
  });
  await step('shotStandalone', () => shot('/tmp/shots/standalone-our-graph.png'));

  // a mode flip must carry open panes across: same count, ours again, nothing stranded
  const census = async () =>
    json(
      await evalJs(`JSON.stringify((function () {
        const app = window.app;
        const reg = app.viewRegistry ?? {};
        const panes = [];
        for (const type of ['graph', 'localgraph', 'fast-graph-view', 'fast-localgraph']) {
          for (const leaf of app.workspace.getLeavesOfType(type)) {
            panes.push({ type, viewType: leaf.view?.getViewType?.() ?? null, ours: !!leaf.view?.presenter, creator: !!reg.viewByType?.[type] });
          }
        }
        const ours = panes.filter((p) => p.ours).length;
        const orphaned = panes.filter((p) => !p.creator).length;
        return { ours, orphaned, panes };
      })())`),
    );
  await step('paneMigration', async () => {
    const off = await census();
    await setTakeover(true);
    await sleep(2500);
    const on = await census();
    const offAgain = await (async () => {
      await setTakeover(false);
      await sleep(2500);
      return await census();
    })();
    await setTakeover(true);
    await sleep(2500);
    const restored = await census();
    return {
      off,
      on,
      offAgain,
      restored,
      preserved: off.ours === on.ours && on.ours === offAgain.ours,
      oursEverywhere: [off, on, offAgain, restored].every((c) => c.ours === c.panes.length),
      neverOrphaned: [off, on, offAgain, restored].every((c) => c.orphaned === 0),
    };
  });

  // 2) back to takeover: existing native leaves must be re-created as ours
  await step('takeoverRestored', () => setTakeover(true));
  await step('refreshTakesOverNativeLeaf', async () => {
    const ready = await waitEngine('graph');
    return {
      ready,
      graphOurs: await evalJs(`window.app.workspace.getLeavesOfType('graph').filter((l) => !!l.view?.presenter).length`),
      graphTotal: await evalJs(`window.app.workspace.getLeavesOfType('graph').length`),
      standaloneLeaves: await evalJs(`window.app.workspace.getLeavesOfType('fast-graph-view').length`),
    };
  });

  // 3) teardown: disable the plugin and count what came back
  const OUTSTANDING = `(function () {
    const live = [];
    try {
      for (const [fn, recs] of (window.__lk?.live?.entries?.() ?? [])) {
        for (const r of recs) live.push({ type: r.type, head: String(fn).slice(0, 50), stack: r.stack });
      }
    } catch (e) { /* the map was replaced by a reload */ }
    const ours = live.filter((l) => (l.stack || '').includes('plugin://fast-graph-view'));
    return {
      total: live.length,
      ours: ours.length,
      sample: live.slice(0, 3).map((o) => o.type + ' @ ' + o.stack),
      ourStacks: ours.map((o) => o.type + ' @ ' + o.stack).slice(0, 6),
      aliveWorkers: (window.__wk?.sites ?? []).filter((s) => s.alive).map((s) => s.url + ' @ ' + s.stack).slice(0, 6),
    };
  })()`;
  await step('disablePlugin', async () => {
    const before = await evalJs(`JSON.stringify({ add: window.__lk.add.pointerup ?? 0, rem: window.__lk.rem.pointerup ?? 0, kd: window.__lk.add.keydown ?? 0, kdr: window.__lk.rem.keydown ?? 0, wk: window.__wk, out: ${OUTSTANDING} })`);
    const r = await evalJs(`(async () => {
      const app = window.app;
      await app.plugins.disablePlugin('fast-graph-view');
      await new Promise((s) => setTimeout(s, 900));
      return JSON.stringify({
        graphLeaves: app.workspace.getLeavesOfType('graph').length,
        standaloneLeaves: app.workspace.getLeavesOfType('fast-graph-view').length,
        localLeaves: app.workspace.getLeavesOfType('fast-localgraph').length,
        canvases: document.querySelectorAll('canvas.fast-graph-gl').length,
        stageEls: document.querySelectorAll('.fast-graph-stage').length,
        grabClass: document.body.classList.contains('is-grabbing'),
        workers: { created: window.__wk.created, terminated: window.__wk.terminated },
        listeners: {
          pointerupAdd: window.__lk.add.pointerup ?? 0,
          pointerupRemove: window.__lk.rem.pointerup ?? 0,
          keydownAdd: window.__lk.add.keydown ?? 0,
          keydownRemove: window.__lk.rem.keydown ?? 0,
        },
        out: ${OUTSTANDING},
      });
    })()`);
    return { before: json(before), after: json(r), delta: null };
  });
  await step('disableDelta', async () => {
    const d = out.disablePlugin ?? {};
    const b = d.before ?? {};
    const a = d.after ?? {};
    return {
      windowPointerup: (a.listeners?.pointerupAdd ?? 0) - (a.listeners?.pointerupRemove ?? 0),
      windowKeydown: (a.listeners?.keydownAdd ?? 0) - (a.listeners?.keydownRemove ?? 0),
      pointerupAddedByDisable: (a.listeners?.pointerupAdd ?? 0) - (b.add ?? 0),
      pointerupRemovedByDisable: (a.listeners?.pointerupRemove ?? 0) - (b.rem ?? 0),
      keydownAddedByDisable: (a.listeners?.keydownAdd ?? 0) - (b.kd ?? 0),
      keydownRemovedByDisable: (a.listeners?.keydownRemove ?? 0) - (b.kdr ?? 0),
      ourListenersBefore: b.out?.ours ?? null,
      ourListenersAfter: a.out?.ours ?? null,
      survivingOurStacks: a.out?.ourStacks ?? null,
      workersCreatedBefore: b.wk?.created ?? null,
      workersTerminatedByDisable: (a.workers?.terminated ?? 0) - (b.wk?.terminated ?? 0),
      aliveWorkersBefore: (b.out?.aliveWorkers ?? []).length,
      aliveWorkersAfter: a.out?.aliveWorkers ?? null,
      canvasesAfter: a.canvases ?? null,
      stageElsAfter: a.stageEls ?? null,
    };
  });
  await step('nativeGraphAfterDisable', async () => {
    const r = await evalJs(`(async () => {
      const app = window.app;
      app.commands.executeCommandById('graph:open');
      await new Promise((s) => setTimeout(s, 1500));
      const l = app.workspace.getLeavesOfType('graph')[0] ?? null;
      return JSON.stringify({ open: !!l, ours: !!(l?.view?.presenter), nativeCanvas: !!l?.view?.contentEl?.querySelector('canvas') });
    })()`);
    return json(r);
  });
  await step('reEnableAndRender', async () => {
    const r = await evalJs(`(async () => {
      const app = window.app;
      await app.plugins.enablePlugin('fast-graph-view');
      await new Promise((s) => setTimeout(s, 800));
      app.commands.executeCommandById('graph:open');
      return 'enabled';
    })()`);
    const ready = await waitEngine('graph', 40000);
    const info = json(
      await evalJs(`(() => {
        const l = window.app.workspace.getLeavesOfType('graph')[0] ?? null;
        const e = l?.view?.presenter?.engine ?? null;
        return JSON.stringify({
          ours: !!(l?.view?.presenter),
          nodes: e?.model?.nodeCount ?? null,
          status: l?.view?.contentEl?.querySelector('.fast-graph-status')?.textContent ?? null,
          workers: window.__wk,
          takeover: window.app.plugins.getPlugin('fast-graph-view')?.settings?.takeover ?? null,
        });
      })()`),
    );
    return { r, ready, ...info };
  });
  await step('settlesAfterReEnable', async () => {
    const idle = await evalJs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const t0 = Date.now();
      let frames = 0;
      let stop = false;
      const tick = () => { frames++; if (!stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      for (let i = 0; i < 120; i++) {
        const e = window.app.workspace.getLeavesOfType('graph')[0]?.view?.presenter?.engine;
        if (e && !e.running && e.alpha <= 0.001) break;
        await sleep(250);
      }
      stop = true;
      const e = window.app.workspace.getLeavesOfType('graph')[0]?.view?.presenter?.engine;
      return JSON.stringify({ idle: !!(e && !e.running), waited: Date.now() - t0, frames, starved: frames * 100 < (Date.now() - t0), alpha: e?.alpha ?? null, raf: e?.raf ?? null });
    })()`);
    return json(idle);
  });
  await step('raiseCheck', async () => {
    await raise();
    return await cadence(1500);
  });
  await step('errors', () => evalJs(`(window.__errs ?? []).slice(-8)`));
  out.final = await step('finalSnapshot', snap);
  return out;
}
