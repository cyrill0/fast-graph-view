import fs from 'node:fs';
import process from 'node:process';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
const args = process.argv.slice(2);
const tag = args.find((arg) => arg !== '--assets');
const checkAssets = args.includes('--assets');

const stableSemver = /^\d+\.\d+\.\d+$/;
const appVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && file.endsWith('.ts') ? [file] : [];
  });
}

requireString(manifest.id, 'manifest.id');
requireString(manifest.name, 'manifest.name');
requireString(manifest.version, 'manifest.version');
requireString(manifest.minAppVersion, 'manifest.minAppVersion');
requireString(manifest.description, 'manifest.description');
requireString(manifest.author, 'manifest.author');

if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) {
  throw new Error(`manifest.id must contain only lowercase letters, numbers, and hyphens; got ${manifest.id}`);
}
if (manifest.description.length > 250) {
  throw new Error(`manifest.description must not exceed 250 characters; got ${manifest.description.length}`);
}
if (typeof manifest.isDesktopOnly !== 'boolean') {
  throw new Error('manifest.isDesktopOnly must be a boolean');
}
if (manifest.authorUrl !== undefined) {
  requireString(manifest.authorUrl, 'manifest.authorUrl');
  const authorUrl = new URL(manifest.authorUrl);
  if (authorUrl.protocol !== 'https:') throw new Error('manifest.authorUrl must use HTTPS');
}

if (!stableSemver.test(manifest.version)) {
  throw new Error(`manifest.version must be a stable semver version; got ${manifest.version}`);
}
if (!appVersion.test(manifest.minAppVersion)) {
  throw new Error(`manifest.minAppVersion must be a version string; got ${manifest.minAppVersion}`);
}
if (manifest.id !== packageJson.name) {
  throw new Error(`manifest.id (${manifest.id}) must match package.name (${packageJson.name})`);
}
if (manifest.version !== packageJson.version) {
  throw new Error(`manifest.version (${manifest.version}) must match package.version (${packageJson.version})`);
}
if (!versions || typeof versions !== 'object' || Array.isArray(versions)) {
  throw new Error('versions.json must be an object mapping plugin versions to minimum app version strings');
}
for (const [version, minimum] of Object.entries(versions)) {
  if (!stableSemver.test(version) || typeof minimum !== 'string' || !appVersion.test(minimum)) {
    throw new Error(`versions.json entry ${version} must map to a minimum app version string`);
  }
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error(
    `versions.json must contain ${manifest.version} with minAppVersion ${manifest.minAppVersion}`,
  );
}
if (tag && tag !== manifest.version && tag !== `v${manifest.version}`) {
  throw new Error(`release tag ${tag} must match manifest version ${manifest.version} (optionally prefixed with v)`);
}

const forbiddenPrivateApis = [
  'internalPlugins',
  'viewRegistry',
  'unregisterView(',
  'unregisterHoverLinkSource',
  'getEnabledPluginById',
  'getPluginById',
];
for (const file of sourceFiles('src')) {
  const source = fs.readFileSync(file, 'utf8');
  for (const marker of forbiddenPrivateApis) {
    if (source.includes(marker)) {
      throw new Error(`${file} contains forbidden private Obsidian API marker: ${marker}`);
    }
  }
}

if (checkAssets) {
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      throw new Error(`release asset ${file} is missing or empty`);
    }
  }
}

console.log(
  `release metadata${checkAssets ? ' and assets are' : ' is'} consistent for ${manifest.id} v${manifest.version}`,
);
