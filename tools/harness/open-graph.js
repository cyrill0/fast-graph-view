(async () => {
  const app = window.app;
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  out.ribbon = [...document.querySelectorAll('.side-dock-ribbon-action')]
    .map((e) => e.dataset?.tooltip ?? e.getAttribute('aria-label') ?? e.querySelector('svg')?.parentElement?.className ?? '?');

  out.commands = Object.keys(app.commands.commands).filter((id) => /graph/i.test(id));

  const before = app.viewRegistry.viewByType['graph'];
  out.nativeCreatorBefore = before ? before.toString().slice(0, 80) : null;

  // open through the core command id, exactly like Mod+G does
  const ran = app.commands.addCommand ? undefined : undefined;
  out.activated = app.commands.executeCommandById('graph:open');

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const leaves = app.workspace.getLeavesOfType('graph');
    if (leaves.length && leaves[0].view?.contentEl?.querySelector('canvas')) break;
  }
  const leaf = app.workspace.getLeavesOfType('graph')[0];
  if (!leaf) return JSON.stringify({ ...out, error: 'no graph leaf' }, null, 1);

  const view = leaf.view;
  out.viewClass = view.getViewType();
  out.displayText = view.getDisplayText();
  out.icon = view.getIcon();
  out.isOurs = !!view.contentEl.querySelector('.fast-graph-stage');
  out.stage = !!view.contentEl.querySelector('.fast-graph-stage');
  out.canvases = [...view.contentEl.querySelectorAll('canvas')].map((c) => ({
    cls: c.className,
    w: c.width,
    h: c.height,
    css: c.style.width + 'x' + c.style.height,
    pos: getComputedStyle(c).position,
  }));
  out.contentElStyle = {
    padding: view.contentEl.style.padding,
    overflow: view.contentEl.style.overflow,
    position: view.contentEl.style.position,
  };
  out.controls = !!view.contentEl.querySelector('.graph-controls');
  out.controlSections = [...view.contentEl.querySelectorAll('.graph-controls > .graph-control-section')]
    .map((s) => ({
      cls: s.className,
      title: s.querySelector('.tree-item-self .collapse-icon')?.nextElementSibling?.textContent ?? s.textContent.slice(0, 20),
      collapsed: s.querySelector('.tree-item-self')?.hasClass?.('is-collapsed') ?? null,
    }));
  out.status = view.contentEl.querySelector('.fast-graph-status')?.textContent ?? null;
  out.probeColors = [...document.querySelectorAll('body > .graph-view')].map((e) => e.className);

  // plugin settings snapshot
  const plugin = app.plugins.getPlugin('fast-graph-view');
  out.settings = plugin ? { takeover: plugin.settings.takeover, cluster: plugin.settings.cluster } : null;
  out.globalType = plugin?.globalType;
  out.localType = plugin?.localType;
  out.creatorAfter = app.viewRegistry.viewByType['graph'] === before ? 'same-instance' : 'replaced';
  return JSON.stringify(out, null, 1);
})()
