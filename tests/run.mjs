import esbuild from 'esbuild';
const result = await esbuild.build({
  entryPoints: ['tests/graph.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  external: ['node:*'],
});

const code = result.outputFiles[0].text;
const b64 = Buffer.from(code, 'utf8').toString('base64');
await import(`data:text/javascript;base64,${b64}`);
