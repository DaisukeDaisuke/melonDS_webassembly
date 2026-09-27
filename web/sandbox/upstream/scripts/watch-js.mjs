import * as esbuild from "esbuild";

const emulatorContext = await esbuild.context({
    entryPoints: ["src/emulator-runtime.js"],
    outfile: "public/emulator.js",
    bundle: true,
    minify: false,
    platform: "browser",
    format: "esm",
    target: ["chrome120"],
    sourcemap: "inline",
    legalComments: "inline",
    loader: { ".worker.js": "text" },
    logLevel: "info"
});

const appContext = await esbuild.context({
    entryPoints: ["src/app.js"],
    outfile: "public/app.js",
    bundle: true,
    minify: false,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    sourcemap: "inline",
    legalComments: "inline",
    external: ["./emulator.js"],
    logLevel: "info"
});

await Promise.all([emulatorContext.watch(), appContext.watch()]);
console.log("Watching src/**/*.js");
