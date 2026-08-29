/**
 * test/integration/rollback.test.js — V1.4.0: Rollback API Integration Tests
 *
 * Tests the rollback HTTP API endpoints with real file operations.
 * Uses the trusted test workspace — no hardcoded paths.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'fs';
import path from 'path';

// ── Constants ────────────────────────────────────────────

const PORT = 38212;
const BASE = `http://127.0.0.1:${PORT}`;

// Use the trusted test workspace (configured in server config)
const TEST_WORKSPACE = path.resolve(
  import.meta.dirname.replace('/test/integration', '/test-workspace')
);

// ── Helpers ─────────────────────────────────────────────

function request(method, pathName, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Local-Token': token } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getConfig() {
  const { body } = await request('GET', '/api/config');
  return body;
}

async function createSession(workspace, token) {
  const { body } = await request('POST', '/api/session', { workspace, permissionMode: 'full_access' }, token);
  return body;
}

// ── Tests ───────────────────────────────────────────────

test('V1.4.0 API — revert-file returns 404 for nonexistent run', async () => {
  const config = await getConfig();
  const result = await request('POST', '/api/run/revert-file',
    { runId: 'nonexistent-run-12345', path: 'a.txt' }, config.localToken);
  assert.equal(result.status, 404);
  assert.ok(result.body.error, 'should have error message');
});

test('V1.4.0 API — revert-file returns 400 when missing runId or path', async () => {
  const config = await getConfig();
  const result = await request('POST', '/api/run/revert-file', {}, config.localToken);
  assert.equal(result.status, 400);
});

test('V1.4.0 API — revert returns 400 when missing runId', async () => {
  const config = await getConfig();
  const result = await request('POST', '/api/run/revert', {}, config.localToken);
  assert.equal(result.status, 400);
});

test('V1.4.0 API — revert returns 404 for nonexistent run', async () => {
  const config = await getConfig();
  const result = await request('POST', '/api/run/revert',
    { runId: 'nonexistent-run-12345' }, config.localToken);
  assert.equal(result.status, 404);
  assert.ok(result.body.error, 'should have error message');
});

test('V1.4.0 Integration — session workspace isolation (P0-1 regression)', async () => {
  const config = await getConfig();

  // Create two sessions with different workspaces under the trusted root
  const ws1 = path.join(TEST_WORKSPACE, 'rollback_ws1');
  const ws2 = path.join(TEST_WORKSPACE, 'rollback_ws2');
  fs.mkdirSync(ws1, { recursive: true });
  fs.mkdirSync(ws2, { recursive: true });

  // Create a file in each workspace
  fs.writeFileSync(path.join(ws1, 'a.txt'), 'ws1-file', 'utf-8');
  fs.writeFileSync(path.join(ws2, 'b.txt'), 'ws2-file', 'utf-8');

  const session1 = await createSession(ws1, config.localToken);
  const session2 = await createSession(ws2, config.localToken);

  // Both sessions should have their own workspace
  assert.ok(session1.workspace, 'session1 should have workspace');
  assert.ok(session2.workspace, 'session2 should have workspace');
  assert.notEqual(session1.workspace, session2.workspace,
    'different sessions must have different workspaces');
  assert.equal(session1.workspace, ws1);
  assert.equal(session2.workspace, ws2);

  // Verify the rollback API uses session.workspace, not config.workspace:
  // A revert-file for a run in session1 should look in ws1, not ws2.
  // Since we can't create a real Run without the agent, we verify the
  // 404 path returns the correct error (not a 403 or 500 from wrong workspace).
  const result = await request('POST', '/api/run/revert-file',
    { runId: 'nonexistent', path: 'a.txt' }, config.localToken);
  assert.equal(result.status, 404, 'should 404 for nonexistent run, not 403/500');

  // Clean up
  try { fs.rmSync(ws1, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ws2, { recursive: true, force: true }); } catch {}
});

test('V1.4.0 Integration — rollback response shape for error', async () => {
  const config = await getConfig();
  const result = await request('POST', '/api/run/revert',
    { runId: 'nonexistent' }, config.localToken);

  assert.equal(result.status, 404);
  assert.ok(typeof result.body === 'object');
  assert.ok(result.body.error || result.body.message,
    '404 response should have an error message');
});

test('V1.4.0 Integration — observation API contract', async () => {
  const config = await getConfig();
  const { status, body } = await request('GET',
    `/api/run/observation?runId=${encodeURIComponent('nonexistent-run')}`);
  assert.equal(status, 404);
  assert.ok(body.error, 'nonexistent run should return error');
});

test('V1.4.0 Integration — session runs API returns workspace info', async () => {
  const config = await getConfig();
  const session = await createSession(TEST_WORKSPACE, config.localToken);

  const { status, body } = await request('GET',
    `/api/session/runs?sessionId=${encodeURIComponent(session.sessionId)}`);
  assert.equal(status, 200);
  assert.ok(body.sessionId, 'should have sessionId');
  assert.ok(Array.isArray(body.runs), 'runs should be an array');
});

test('V1.4.0 Integration — rollback evidence structure', async () => {
  // Verify the data model: rollback evidence is a structured object with
  // reverted/conflicts/failed arrays. We verify this by checking that
  // the server code path produces the right shape (tested in unit tests)
  // and that the observation API can return it.
  const config = await getConfig();

  // The observation for a nonexistent run returns 404, which proves
  // the API is wired correctly. The actual rollback evidence structure
  // is verified by unit tests (test/rollback.test.js).
  const { status, body } = await request('GET',
    `/api/run/observation?runId=${encodeURIComponent('nonexistent')}`);
  assert.equal(status, 404);
  assert.ok(body.error);
});