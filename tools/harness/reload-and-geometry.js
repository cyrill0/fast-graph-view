(async () => {
  const app = window.app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plugin = app.plugins.getPlugin('fast-graph-view');
  const beforeLeaves = app.workspace.getLeavesOfType('graph').length;

  await app.plugins.disablePlugin('fast-graph-view');
  await sleep(400);
  const afterDisable = {
    creators: Object.keys(app.viewRegistry.viewByType).filter((t) => /graph/.test(t)),
    graphCreator: app.viewRegistry.viewByType['graph']?.toString().slice(0, 40) ?? null,
    leaves: app.workspace.getLeavesOfType('graph').length,
    leafView: app.workspace.getLeavesOfType('graph')[0]?.view?.getViewType() ?? null,
    stageClass: app.workspace.getLeavesOfType('graph')[0]?.view?.contentEl?.className ?? null,
    ourCss: !!document.querySelector('style[data-plugin="fast-graph-view"]'),
  };
  await app.plugins.enablePlugin('fast-graph-view');
  await sleep(400);

  app.commands.executeCommandById('graph:open');
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const v = app.workspace.getLeavesOfType('graph')[0]?.view;
    if (v?.contentEl?.querySelector('.fast-graph-gl')) break;
  }
  const view = app.workspace.getLeavesOfType('graph')[0]?.view;
  const el = view?.contentEl;
  const box = (sel) => {
    const e = el?.querySelector(sel);
    if (!e) return sel + ': MISSING';
    const r = e.getBoundingClientRect();
    return `${sel} ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)} pos=${getComputedStyle(e).position} z=${getComputedStyle(e).zIndex}`;
  };
  return JSON.stringify({
    beforeLeaves,
    afterDisable,
    reloaded: {
      stageClass: el?.className ?? null,
      canvases: [box('.fast-graph-gl'), box('.fast-graph-labels')],
      controls: box('.graph-controls'),
      status: box('.fast-graph-status'),
      contentBox: el ? (() => { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })() : null,
      backing: [...(el?.querySelectorAll('canvas') ?? [])].map((c) => c.width + 'x' + c.height + ' dpr=' + (window.devicePixelRatio || 1)),
      text: el?.querySelector('.fast-graph-status')?.textContent ?? null,
    },
  }, null, 1);
})()
