// One ESM serves both the UI and Emscripten pthread imports. Workers must not
// initialize the DOM or recursively start another emulator dispatcher.
export { default } from './dist/melonds.js';
export { startEngine } from './engine.worker.js';
if (typeof document !== 'undefined') await import('./app.js');
