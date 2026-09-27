// Bundle the *upstream* DeSmuME parser, eval, and persistent Worker layers.
// Keep their sandbox hardening, hashed Acorn dependency, and supervisors intact.
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = resolve(project, process.argv[2] || 'web/sandbox/upstream');
const output = resolve(project, 'web/dist/script-workers.js');
process.chdir(source);
const requireFromReference = createRequire(join(source, 'package.json'));
const esbuild = requireFromReference('esbuild');
const { buildDependencySources } = await import(pathToFileURL(join(source, 'scripts/dependency-bundle-policy.mjs')));
const dependencies = await buildDependencySources();
const acorn = dependencies.get(resolve('src/dependencies/acorn.dependency-source.js'));
if (!acorn) throw Error('Audited Acorn bundle is missing');
const names = ['parser', 'eval', 'eval-supervisor', 'persistent-script', 'persistent-script-supervisor'];
const sources = {};
for (const name of names) {
  const result = await esbuild.build({
    entryPoints: [`src/workers/${name}.worker.js`], bundle: true, write: false,
    minify: true, platform: 'browser', format: 'iife', target: ['chrome120'],
    legalComments: 'none', logLevel: 'silent'
  });
  sources[name] = result.outputFiles[0].text;
}
await writeFile(output, `// Built from pinned DeSmuME source. GPL-3.0-or-later.\nexport const sources = ${JSON.stringify(sources)};\nexport const dependency = ${JSON.stringify({ source: acorn.source, sha256: acorn.sha256 })};\n`);
