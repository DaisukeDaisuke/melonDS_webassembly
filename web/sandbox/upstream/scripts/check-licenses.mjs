import { readFile } from "node:fs/promises";
import * as esbuild from "esbuild";

const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const metafiles = [];
for (const entryPoint of ["src/dependencies/acorn.entry.js", "src/dependencies/ssim.entry.js"]) {
  const result = await esbuild.build({
    entryPoints: [entryPoint], bundle: true, write: false, metafile: true,
    platform: "browser", format: "iife", logLevel: "silent"
  });
  metafiles.push(result.metafile);
}
const bundledPackages = new Set();
for (const metafile of metafiles) {
  for (const input of Object.keys(metafile.inputs)) {
    const normalized = input.replaceAll("\\", "/");
    const match = normalized.match(/(?:^|\/)node_modules\/(?:@([^/]+)\/)?([^/]+)\//);
    if (match) bundledPackages.add(match[1] ? `@${match[1]}/${match[2]}` : match[2]);
  }
}
const declared = new Set(Object.keys(packageJson.dependencies || {}));
for (const name of new Set([...declared, ...bundledPackages])) {
  if (!declared.has(name)) throw new Error(`Bundled production dependency is undeclared: ${name}`);
  if (!bundledPackages.has(name)) throw new Error(`Declared production dependency is absent from bundle metafiles: ${name}`);
  const version = packageJson.dependencies[name];
  const locked = lock.packages?.[`node_modules/${name}`];
  if (!/^(?:\d+\.){2}\d+(?:[-+].+)?$/.test(version) || locked?.version !== version) {
    throw new Error(`Production dependency is not exactly locked: ${name}@${version}`);
  }
  if (!new Set(["MIT", "ISC", "BSD-2-Clause"]).has(locked.license)) {
    throw new Error(`Production dependency has an unapproved or unknown license: ${name}@${version} (${locked.license || "missing"})`);
  }
  if (!notices.toLowerCase().includes(`${name} ${version}`.toLowerCase())) {
    throw new Error(`Missing bundled dependency notice: ${name}@${version}`);
  }
}
for (const required of ["coi-serviceworker", "esbuild", "terser", "MIT License text"]) {
  if (!notices.includes(required)) throw new Error(`Missing third-party notice: ${required}`);
}
