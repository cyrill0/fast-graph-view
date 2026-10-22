import esbuild from 'esbuild';
const result = await esbuild.build({
  entryPoints: ['tests/graph.test.ts', 'tests/i18n.test.ts', 'tests/labels.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  outdir: 'tests/.bundle',
  external: ['node:*'],
});

for (const file of result.outputFiles) {
  const b64 = Buffer.from(file.text, 'utf8').toString('base64');
  await import(`data:text/javascript;base64,${b64}`);
}
