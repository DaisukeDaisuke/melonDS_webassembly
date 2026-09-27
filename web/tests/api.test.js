import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../api.js';
import { loadLayout, saveLayout, makeTile } from '../layout.js';

test('instanceId is mandatory even if a UI tile selects a console', async () => {
  const api = createApi({ execute: async () => 'done' });
  await assert.rejects(api.pause({}), /instanceId/);
  await assert.rejects(api.pause({ instanceId: 16 }), /instanceId/);
  assert.equal(await api.pause({ instanceId: 0 }), 'done');
});

test('operations await completion and order same-instance changes', async () => {
  let finish;
  const calls = [];
  const api = createApi({ execute: name => {
    calls.push(name);
    return name === 'reset' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(name);
  }});
  const reset = api.reset({ instanceId: 2 });
  const step = api.step({ instanceId: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['reset']);
  finish('reset complete');
  assert.equal(await reset, 'reset complete');
  assert.equal(await step, 'step');
  assert.deepEqual(calls, ['reset', 'step']);
});

test('bulk ROM load waits on affected instances and rejects duplicate ids', async () => {
  const calls = [];
  const api = createApi({ execute: async (name, args) => { calls.push([name, args]); return true; } });
  await assert.rejects(api.loadRomMany({ instanceIds: [1, 1], file: new Blob() }), /unique/);
  await api.loadRomMany({ instanceIds: [0, 3], file: new Blob([1]) });
  assert.equal(calls[0][0], 'loadRomMany');
});

test('layout persists each tile target and restores malformed storage safely', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const layout = { mode: 'free', tiles: [makeTile('memory', { instanceId: 9, cpu: 'ARM7', x: 24 })] };
  saveLayout(layout, storage);
  assert.equal(loadLayout(storage).tiles[0].instanceId, 9);
  assert.equal(loadLayout(storage).tiles[0].cpu, 'ARM7');
  storage.setItem('melonds.workspace.v1', '{');
  assert.equal(loadLayout(storage).mode, 'grid');
});
