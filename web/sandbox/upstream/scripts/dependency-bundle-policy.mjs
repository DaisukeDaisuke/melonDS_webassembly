import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEPENDENCY_ENTRIES = Object.freeze([
  ["src/dependencies/acorn.entry.js", "src/dependencies/acorn.dependency-source.js", "__desmumeAcorn"],
  ["src/dependencies/ssim.entry.js", "src/dependencies/ssim.dependency-source.js", "__desmumeSsim"]
]);

export async function buildDependencySources() {
  const expectedDependencyHashes = JSON.parse(await readFile("src/dependencies/expected-hashes.json", "utf8"));
  const dependencySources = new Map();
  for (const [entryPoint, sourceModule, globalName] of DEPENDENCY_ENTRIES) {
    const result = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      minify: true,
      platform: "browser",
      format: "iife",
      globalName,
      target: ["chrome120"],
      legalComments: "none",
      logLevel: "silent",
      metafile: true
    });
    const source = `${result.outputFiles[0].text}\n${globalName}`;
    await assertNoDependencyImports(result, entryPoint);
    const sha256 = createHash("sha256").update(source).digest("hex");
    if (expectedDependencyHashes[sourceModule] !== sha256) {
      throw new Error(`${sourceModule} SHA-256 ${sha256} does not match the fixed audited hash`);
    }
    dependencySources.set(resolve(sourceModule), Object.freeze({
      source,
      sha256,
      metafile: result.metafile
    }));
  }
  return dependencySources;
}

async function assertNoDependencyImports(result, entryPoint) {
  const imports = Object.entries(result.metafile.outputs)
    .flatMap(([output, metadata]) => (metadata.imports || []).map((item) => ({ output, ...item })));
  if (imports.length) {
    throw new Error(`${entryPoint} dependency bundle retained imports: ${
      imports.map((item) => `${item.path}:${item.kind}`).join(", ")
    }`);
  }
  try {
    await esbuild.transform(result.outputFiles[0].text, {
      loader: "js",
      target: ["chrome120"],
      supported: { "dynamic-import": false },
      logLevel: "silent"
    });
  } catch (error) {
    throw new Error(`${entryPoint} dependency bundle contains unsupported syntax: ${error.message}`);
  }
}
