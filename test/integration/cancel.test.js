/**
 * Integration Test: Cancel / Process Lifecycle
 */

import { test } from 'node:test';
import assert from 'assert';
import { spawn } from 'child_process';
import { ActiveRun } from '../../runmanager.js';
import { ApprovalRegistry } from '../../approval.js';

test('stop kills child process tree', async () => {
  const run = new ActiveRun('test-session');

  const child = spawn('sleep', ['300'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  run.registerChild(child);

  await new Promise((r) => setTimeout(r, 100));

  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.ok(alive, 'process should be running');

  run.stop('user_stop');

  await new Promise((r) => setTimeout(r, 3000));

  let stillAlive = true;
  try { process.kill(child.pid, 0); } catch { stillAlive = false; }
  assert.ok(!stillAlive, 'process should be dead after stop');

  assert.ok(run.isStopped(), 'run should be stopped');
  assert.strictEqual(run.stopReason, 'user_stop');
});

test('stop does not affect other runs', async () => {
  const runA = new ActiveRun('session-a');
  const runB = new ActiveRun('session-b');

  const childA = spawn('sleep', ['300'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const childB = spawn('sleep', ['300'], { stdio: ['ignore', 'pipe', 'pipe'] });

  runA.registerChild(childA);
  runB.registerChild(childB);

  await new Promise((r) => setTimeout(r, 100));

  runA.stop('user_stop');

  assert.ok(runA.isStopped(), 'A should be stopped');
  assert.ok(!runB.isStopped(), 'B should not be stopped');

  let bAlive = true;
  try { process.kill(childB.pid, 0); } catch { bAlive = false; }
  assert.ok(bAlive, 'B process should still be running');

  runB.stop('user_stop');
  await new Promise((r) => setTimeout(r, 3000));
});

test('approval cancelRun only affects the specified run', async () => {
  const reg = new ApprovalRegistry();

  const promiseA = reg.register('run-a', 'tc-a', 100);
  reg.register('run-b', 'tc-b', 10000);

  reg.cancelRun('run-a');

  const resultA = await promiseA;
  assert.strictEqual(resultA, false, 'A should be cancelled');

  // B should still be pending - check via registry state
  assert.strictEqual(reg.size, 1, 'B should still have a pending approval');

  reg.cancelRun('run-b');
  assert.strictEqual(reg.size, 0, 'B should be cancelled');
});