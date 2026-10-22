// Fixed-root standalone local-graph scenario for a running Obsidian instance.

const SNAPSHOT = `(() => {
  const leaf = window.app.workspace.getLeavesOfType('fast-localgraph')[0] ?? null;
  const view = leaf?.view ?? null;
  const engine = view?.presenter?.engine ?? null;
  return JSON.stringify({
    leaves: window.app.workspace.getLeavesOfType('fast-localgraph').length,
    root: engine?.scopePath ?? null,
    activeFile: window.app.workspace.getActiveFile()?.path ?? null,
    state: leaf?.getViewState?.().state ?? null,
    nodes: engine?.model?.nodeCount ?? null,
    canvas: !!view?.contentEl?.querySelector('canvas.fast-graph-gl'),
  });
})()`;

export default async function ({ evalJs, sleep, wake, raise, shot }) {
  await wake();
  await raise();

  const files = JSON.parse(await evalJs(`JSON.stringify(window.app.vault.getMarkdownFiles().slice(0, 2).map((file) => file.path))`));
  if (!files[0]) throw new Error('The vault needs at least one Markdown file');

  await evalJs(`window.app.workspace.detachLeavesOfType('fast-localgraph')`);
  await evalJs(`window.app.workspace.openLinkText(${JSON.stringify(files[0])}, '', false)`);
  await sleep(500);
  await evalJs(`window.app.commands.executeCommandById('fast-graph-view:open-local')`);

  let opened = null;
  for (let i = 0; i < 80; i++) {
    opened = JSON.parse(await evalJs(SNAPSHOT));
    if (opened.canvas && opened.nodes !== null) break;
    await sleep(250);
  }
  if (!opened || opened.root !== files[0] || !opened.canvas) {
    throw new Error(`Local graph did not open on its source file: ${JSON.stringify(opened)}`);
  }

  if (files[1]) {
    await evalJs(`window.app.workspace.openLinkText(${JSON.stringify(files[1])}, '', false)`);
    await sleep(750);
  }
  const afterNavigation = JSON.parse(await evalJs(SNAPSHOT));
  if (afterNavigation.root !== files[0]) {
    throw new Error(`Local graph root changed after navigation: ${JSON.stringify(afterNavigation)}`);
  }

  await shot('/tmp/fast-graph-local.png');
  return { files, opened, afterNavigation };
}
