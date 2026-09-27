import * as esbuild from "esbuild";

await Promise.all([
  esbuild.build({
    entryPoints: ["src/app.js"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    external: ["./emulator.js"],
    logLevel: "warning"
  }),
  esbuild.build({
    entryPoints: ["src/emulator-runtime.js"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: ["chrome120"],
    loader: { ".worker.js": "text" },
    logLevel: "warning"
  })
]);
