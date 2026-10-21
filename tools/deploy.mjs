import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vault = path.resolve(process.env.OBSIDIAN_VAULT ?? path.join(root, 'test-vault'));
const pluginId = 'fast-graph-view';
const target = path.join(vault, '.obsidian', 'plugins', pluginId);

await fs.mkdir(target, { recursive: true });
for (const file of ['main.js', 'styles.css', 'manifest.json']) {
  await fs.copyFile(path.join(root, file), path.join(target, file));
}

console.log(`deployed ${pluginId} to ${target}`);