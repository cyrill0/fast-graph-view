import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vault = path.resolve(process.env.OBSIDIAN_VAULT ?? path.join(root, 'test-vault'));
const pluginId = 'fast-graph-view';
const target = path.join(vault, '.obsidian', 'plugins', pluginId);
const rawPort = Number.parseInt(process.env.OBS_CDP_PORT ?? '9223', 10);
const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? String(rawPort) : '9223';
const files = ['main.js', 'styles.css', 'manifest.json'];
let reloadQueued = false;
let reloadRunning = false;

async function deploy() {
  await fsPromises.mkdir(target, { recursive: true });
  for (const file of files) {
    await fsPromises.copyFile(path.join(root, file), path.join(target, file));
  }
  console.log(`[dev:vault] deployed ${new Date().toLocaleTimeString()}`);
}

async function reloadPlugin() {
  if (reloadRunning) {
    reloadQueued = true;
    return;
  }
  reloadRunning = true;
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`);
  } catch {
    console.log(`[dev:vault] Obsidian CDP is unavailable on port ${port}; copied files without reload`);
    reloadRunning = false;
    return;
  }
  const expression = `(async () => {
    const plugin = window.app?.plugins;
    if (!plugin?.getPlugin('${pluginId}')) return 'plugin not enabled';
    await plugin.disablePlugin('${pluginId}');
    await plugin.enablePlugin('${pluginId}');
    return 'reloaded';
  })()`;
  const child = spawn(process.execPath, [path.join(root, 'tools', 'obs-cdp.mjs'), '--await', expression], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OBS_CDP_PORT: port },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve) => child.once('close', resolve));
  if (output.trim()) console.log(`[dev:vault] ${output.trim()}`);
  reloadRunning = false;
  if (reloadQueued) {
    reloadQueued = false;
    await reloadPlugin();
  }
}

await deploy();
const build = spawn('pnpm', ['watch'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
build.stdout.pipe(process.stdout);
build.stderr.pipe(process.stderr);

let timer;
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await deploy();
    await reloadPlugin();
  }, 150);
};
for (const file of files) fs.watch(path.join(root, file), schedule);

console.log(`[dev:vault] watching ${root}`);
console.log(`[dev:vault] vault ${vault}`);
console.log(`[dev:vault] live reload uses CDP port ${port}; start Obsidian with --remote-debugging-port=${port}`);

const stop = () => build.kill('SIGTERM');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
build.once('exit', (code) => process.exit(code ?? 0));
