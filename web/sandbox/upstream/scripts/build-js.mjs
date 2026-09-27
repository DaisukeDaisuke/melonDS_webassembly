import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildDependencySources } from "./dependency-bundle-policy.mjs";

const bundledWorkers = new Map();
for (const entryPoint of [
  "src/workers/parser.worker.js",
  "src/workers/eval.worker.js",
  "src/workers/eval-supervisor.worker.js",
  "src/workers/persistent-script.worker.js",
  "src/workers/persistent-script-supervisor.worker.js",
  "src/workers/algorithm.worker.js"
]) {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    minify: true,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    legalComments: "none",
    logLevel: "silent"
  });
  bundledWorkers.set(resolve(entryPoint), result.outputFiles[0].text);
}

const dependencySources = await buildDependencySources();

const embeddedWorkersPlugin = {
  name: "embedded-workers",
  setup(build) {
    build.onLoad({ filter: /\.dependency-source\.js$/ }, ({ path }) => {
      const dependency = dependencySources.get(resolve(path));
      if (!dependency) throw new Error(`Unknown dependency source module: ${path}`);
      return {
        contents: `export default Object.freeze(${JSON.stringify({ source: dependency.source, sha256: dependency.sha256 })});`,
        loader: "js"
      };
    });
    build.onLoad({ filter: /\.worker\.js$/ }, async ({ path }) => ({
      contents: bundledWorkers.get(resolve(path)) ?? await readFile(path, "utf8"),
      loader: "text"
    }));
  }
};

await esbuild.build({
  entryPoints: ["src/emulator-runtime.js"],
  outfile: "public/emulator.js",
  bundle: true,
  minify: true,
  platform: "browser",
  format: "esm",
  target: ["chrome120"],
  sourcemap: false,
  legalComments: "external",
  plugins: [embeddedWorkersPlugin],
  logLevel: "info"
});

await esbuild.build({
  entryPoints: ["src/app.js"],
  outfile: "public/app.js",
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  target: ["chrome120"],
  sourcemap: false,
  legalComments: "external",
  external: ["./emulator.js"],
  logLevel: "info"
});
