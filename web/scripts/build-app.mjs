import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const esbuild = createRequire(join(root, 'web/sandbox/upstream/package.json'))('esbuild');
const out = join(root, 'public');
await mkdir(out, { recursive: true });
await esbuild.build({
  entryPoints: [join(root, 'web/entry.js')], outfile: join(out, 'main.js'),
  bundle: true, minify: true, format: 'esm', platform: 'browser', target: ['chrome120'],
  legalComments: 'external', logLevel: 'info',
  plugins: [{ name: 'pthread-source', setup(build) {
    build.onResolve({ filter: /melonds\.worker\.js$/ }, () => ({ path: 'pthread-bootstrap', namespace: 'pthread-source' }));
    build.onLoad({ filter: /.*/, namespace: 'pthread-source' }, async () => {
      // Older Emscripten emits a separate worker. Newer versions embed the
      // pthread bootstrap in melonds.js and do not emit this file at all.
      let contents = '';
      try { contents = await readFile(join(root, 'web/dist/melonds.worker.js'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { contents, loader: 'text' };
    });
  } }]
});
const html = await readFile(join(root, 'web/index.html'), 'utf8');
const css = await readFile(join(root, 'web/style.css'), 'utf8') + '\n' + await readFile(join(root, 'web/debugger.css'), 'utf8');
await writeFile(join(out, 'index.html'), html.replace('<link rel="stylesheet" href="./style.css">', `<style>${css}</style>`));
const buildId = createHash('sha256').update(await readFile(join(out, 'main.js'))).update(await readFile(join(root, 'web/dist/melonds.wasm'))).digest('hex').slice(0, 20);
await writeFile(join(out, 'loader.js'), (await readFile(join(root, 'web/loader.js'), 'utf8')).replace('__MELONDS_BUILD_ID__', buildId));
await rm(join(out, 'dist'), { recursive: true, force: true });
await cp(join(root, 'web/dist'), join(out, 'dist'), { recursive: true });
await copyFile(join(root, 'web/dist/melonds.wasm'), join(out, 'melonds.wasm'));
await copyFile(join(root, 'LICENSE'), join(out, 'LICENSE'));
await copyFile(join(root, 'API.md'), join(out, 'API.md'));
try { await cp(join(root, 'web/dq9/certs'), join(out, 'dq9/certs'), { recursive: true }); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log('public: index.html, loader.js, main.js, melonds.wasm, dist/');
