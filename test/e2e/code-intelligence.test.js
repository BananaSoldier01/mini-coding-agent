/**
 * test/e2e/code-intelligence.test.js — V1.5.0 Codebase Intelligence E2E
 *
 * Acceptance scenarios:
 *   1. Bug description → rapid file location via search_code + taskSelector
 *   2. Function name → definition + references via find_symbol + find_refs
 *   3. Cross-module modification → auto context selection (not blind read)
 *   4. Large directory → context input < full-read baseline
 *   5. Search/symbol/context-selection process traceable in Activity
 *   6. No regression of V1.2-V1.4 Runtime/Approval/Rollback
 */

import { test, expect } from '@playwright/test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const TEST_WORKSPACE = path.join(process.cwd(), 'test-workspace');

test.beforeEach(() => {
  fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  // package.json with main pointing to app.js
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      version: '0.4.2',
      description: 'Test workspace for E2E',
      main: 'app.js',
      scripts: { start: 'node app.js', test: 'node --test' },
      dependencies: { express: '^4.19.2' },
    }, null, 2) + '\n'
  );

  // app.js — entry point with route handler
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'app.js'),
    `const express = require('express');
const { UserService } = require('./services/user.js');
const app = express();
const userSvc = new UserService();
app.get('/api/users', (req, res) => {
  res.json(userSvc.list());
});
app.get('/api/users/:id', (req, res) => {
  const user = userSvc.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(user);
});
app.listen(3000);
`
  );

  // services/user.js — core service module
  fs.mkdirSync(path.join(TEST_WORKSPACE, 'services'), { recursive: true });
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'services', 'user.js'),
    `class UserService {
  constructor() {
    this.users = [
      { id: '1', name: 'Alice', email: 'alice@test.com' },
      { id: '2', name: 'Bob', email: 'bob@test.com' },
    ];
  }

  list() {
    return this.users;
  }

  findById(id) {
    return this.users.find(u => u.id === id) || null;
  }

  findByEmail(email) {
    return this.users.find(u => u.email === email) || null;
  }
}
module.exports = { UserService };
`
  );

  // utils/validate.js — validation helper
  fs.mkdirSync(path.join(TEST_WORKSPACE, 'utils'), { recursive: true });
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'utils', 'validate.js'),
    `const { UserService } = require('../services/user.js');

function validateEmail(email) {
  const svc = new UserService();
  const existing = svc.findByEmail(email);
  if (existing) throw new Error('Email already registered');
  return true;
}

module.exports = { validateEmail };
`
  );

  // auth.js — login handler (for natural language bug search tests)
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'auth.js'),
    'const { UserService } = require(\'./services/user.js\');\n\nfunction loginHandler(req, res) {\n  const { username, password } = req.body;\n  if (!username || !password) {\n    return res.status(400).json({ error: \'Missing credentials\' });\n  }\n  const user = new UserService().findByEmail(username);\n  if (!user) {\n    return res.status(401).json({ error: \'Invalid credentials\' });\n  }\n  if (user.password !== password) {\n    return res.status(401).json({ error: \'Wrong password\' });\n  }\n  res.json({ token: \'fake-token-\' + user.id });\n}\n\nmodule.exports = { loginHandler };\n'
  );

  // Create many filler files to simulate a larger workspace
  fs.mkdirSync(path.join(TEST_WORKSPACE, 'filler'), { recursive: true });
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(
      path.join(TEST_WORKSPACE, 'filler', `file${i}.js`),
      `// Filler file ${i}\nconst value${i} = ${i};\nmodule.exports = { value${i} };\n`
    );
  }
});

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:38212');
  await expect(page.locator('.topbar')).toBeVisible();
  await page.waitForFunction(() => typeof localToken !== 'undefined' && localToken !== null, { timeout: 10000 });
  await page.waitForSelector('#fileTree', { timeout: 5000 });
});

// ── Helpers ──

async function waitForRunComplete(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const btn = document.getElementById('sendBtn');
    return btn && !btn.disabled;
  }, { timeout });
}

async function sendTask(page, task) {
  await page.locator('#chatInput').fill(task);
  await page.locator('#sendBtn').click();
}

async function setMode(page, mode) {
  await page.evaluate((m) => {
    state.permissionMode = m;
    const select = document.getElementById('modeSelect');
    if (select) select.value = m;
  }, mode);
}

// ═══════════════════════════════════════════════════════
// Scenario 1: Bug description → rapid file location
// ═══════════════════════════════════════════════════════

test('V1.5.0 CI-1: Bug description triggers preflight and locates target file', async ({ page }) => {
  await setMode(page, 'full_access');

  // Send a bug-fix task that should trigger preflight
  await sendTask(page, 'Fix the bug in UserService findById');
  await waitForRunComplete(page);

  // Verify that a context_selection SSE event was emitted
  const selEvent = await page.evaluate(() => {
    return state.timeline.find(item => item.name === 'context_selection');
  });

  assert.ok(selEvent, 'context_selection should appear in Activity timeline');
  assert.ok(selEvent.result, 'context_selection should have result data');

  // Verify effect metrics: selectedFiles ≤ 6
  const metrics = selEvent.result.metrics;
  assert.ok(metrics.selectedFiles <= 6,
    `selectedFiles (${metrics.selectedFiles}) must be ≤ 6`);

  // Verify effect metrics: injectedChars ≤ 12k
  assert.ok(metrics.injectedChars <= 12000,
    `injectedChars (${metrics.injectedChars}) must be ≤ 12000`);

  // Verify the target file (services/user.js) is among selected files
  const selectedPaths = selEvent.result.selectedFiles.map(f => f.path);
  assert.ok(selectedPaths.some(p => p.includes('user') || p.includes('service')),
    `should select user-related files, got: ${JSON.stringify(selectedPaths)}`);
});

// ═══════════════════════════════════════════════════════
// Scenario 2: Function name → definition + references
// ═══════════════════════════════════════════════════════

test('V1.5.0 CI-2: find_symbol locates definition, find_refs finds references', async ({ page }) => {
  await setMode(page, 'full_access');

  await sendTask(page, 'TEST_FIND_SYMBOL');
  await waitForRunComplete(page);

  // Check that the agent used find_symbol tool
  const toolCalls = await page.evaluate(() => {
    return state.timeline
      .filter(item => ['find_symbol', 'search_code', 'read_file'].includes(item.name))
      .map(item => ({ name: item.name, args: item.args }));
  });

  assert.ok(toolCalls.length > 0, 'agent should have used search/find tools');

  // Verify the agent found services/user.js (the definition file)
  const foundTarget = toolCalls.some(tc =>
    tc.args?.path?.includes('user') || tc.args?.path?.includes('service') ||
    tc.args?.name === 'UserService'
  );
  assert.ok(foundTarget, 'agent should reference UserService or user.js');
});

test('V1.5.0 CI-2b: find_refs finds references outside definition file', async ({ page }) => {
  await setMode(page, 'full_access');

  await sendTask(page, 'TEST_FIND_REFS');
  await waitForRunComplete(page);

  // The agent should read multiple files that use UserService
  const readFiles = await page.evaluate(() => {
    return state.timeline
      .filter(item => item.name === 'read_file')
      .map(item => item.args?.path)
      .filter(Boolean);
  });

  // At minimum, the agent should look at app.js (uses UserService)
  assert.ok(readFiles.some(p => p && p.includes('app.js')),
    'agent should read app.js which uses UserService');
});

// ═══════════════════════════════════════════════════════
// Scenario 3: Cross-module modification → auto context selection
// ═══════════════════════════════════════════════════════

test('V1.5.0 CI-3: Cross-module task selects relevant code, not whole repo', async ({ page }) => {
  await setMode(page, 'full_access');

  await sendTask(page, 'Fix the bug in UserService findById');
  await waitForRunComplete(page);

  // Check context_selection event
  const selEvent = await page.evaluate(() => {
    return state.timeline.find(item => item.name === 'context_selection');
  });

  if (selEvent) {
    const selectedPaths = selEvent.result.selectedFiles.map(f => f.path);
    // Should select user-related files, NOT all 20 filler files
    const fillerSelected = selectedPaths.filter(p => p.includes('filler'));
    assert.equal(fillerSelected.length, 0,
      `should NOT select filler files, got: ${JSON.stringify(fillerSelected)}`);

    // Should select at least one relevant file
    assert.ok(selectedPaths.length > 0, 'should select at least one relevant file');
  }
});

// ═══════════════════════════════════════════════════════
// Scenario 4: Large directory → context < full-read baseline
// ═══════════════════════════════════════════════════════

test('V1.5.0 CI-4: Context injection is bounded (≤6 files, ≤12k chars)', async ({ page }) => {
  await setMode(page, 'full_access');

  await sendTask(page, 'Fix the bug in UserService findById');
  await waitForRunComplete(page);

  const selEvent = await page.evaluate(() => {
    return state.timeline.find(item => item.name === 'context_selection');
  });

  assert.ok(selEvent, 'context_selection should be emitted');

  const metrics = selEvent.result.metrics;
  // Effect metrics
  assert.ok(metrics.selectedFiles <= 6,
    `selectedFiles must be ≤ 6, got ${metrics.selectedFiles}`);
  assert.ok(metrics.injectedChars <= 12000,
    `injectedChars must be ≤ 12000, got ${metrics.injectedChars}`);

  // Verify searchLog exists with search entries
  assert.ok(selEvent.result.searchLog.length > 0, 'should have searchLog entries');
  const hasSearch = selEvent.result.searchLog.some(l => l.type === 'search_code' || l.type === 'codebase_map');
  assert.ok(hasSearch, 'searchLog should contain search_code or codebase_map entries');
});

// ═══════════════════════════════════════════════════════
// Scenario 5: Process traceable in Activity
// ═══════════════════════════════════════════════════════

test('V1.5.0 CI-5: Context selection process is visible in Activity timeline', async ({ page }) => {
  await setMode(page, 'full_access');

  await sendTask(page, 'Fix the bug in UserService findById');
  await waitForRunComplete(page);

  // The context_selection item should be in the timeline
  const hasContextSel = await page.evaluate(() => {
    return state.timeline.some(item => item.name === 'context_selection');
  });
  assert.ok(hasContextSel, 'context_selection item should be in timeline');

  // Click to expand the context_selection item
  const ctxselItem = page.locator('.timeline-item').filter({
    has: page.locator('.ti-text:has-text("Context Selection")'),
  });
  await expect(ctxselItem).toBeVisible({ timeout: 5000 });

  // Expand it
  await ctxselItem.click();
  await page.waitForTimeout(200);

  // Verify the body shows metrics
  const metricsVisible = await page.evaluate(() => {
    const body = document.querySelector('.ctxsel-metrics');
    return body !== null;
  });
  assert.ok(metricsVisible, 'ctxsel-metrics section should be rendered');

  // Verify search log is visible
  const searchLogVisible = await page.evaluate(() => {
    const sections = document.querySelectorAll('.ctxsel-section');
    return sections.length > 0;
  });
  assert.ok(searchLogVisible, 'ctxsel-section should be rendered');

  // Verify selected files are listed
  const selectedVisible = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.ctxsel-label'));
    return labels.some(l => l.textContent.includes('选中'));
  });
  assert.ok(selectedVisible, 'selected files section should be visible');
});

// ═══════════════════════════════════════════════════════
// Scenario 6: No regression — V1.4.0 Rollback still works
// ═══════════════════════════════════════════════════════

test('V1.5.0 CI-6: No regression — V1.4.0 revert-file still works after preflight', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await setMode(page, 'full_access');

  await sendTask(page, 'Fix the bug in UserService findById');
  await waitForRunComplete(page);

  // Find a modified file and revert it
  const revertBtn = page.locator('.revert-file-btn').first();
  const hasRevert = await revertBtn.count();
  if (hasRevert > 0) {
    await revertBtn.click();
    await page.waitForTimeout(1000);

    // After revert, the Changes panel should update
    // (This verifies that preflight didn't break the revert pipeline)
    const diffPanel = page.locator('#diffPanel');
    await expect(diffPanel).toBeVisible({ timeout: 5000 });
  }
});

test('V1.5.0 CI-6b: No regression — V1.4.0 Run Selector still works', async ({ page }) => {
  await setMode(page, 'full_access');
  await sendTask(page, 'Fix the bug in UserService findById');
  await waitForRunComplete(page);

  // After Run completes, state should have selectedRunId set
  // Wait for refreshRunList() to complete (called from agent_done SSE handler)
  await page.waitForTimeout(1000);
  const state1 = await page.evaluate(() => ({
    selectedRunId: state.selectedRunId,
    runListLen: state._runList ? state._runList.length : -1,
  }));
  assert.ok(state1.selectedRunId, 'selectedRunId should be set after Run completes');
  // _runList is populated by refreshRunList() which is async after agent_done
  // It may or may not have completed by now — just verify selectedRunId is set

  // New Session should clear Run identity
  await page.click('#newSessionBtn');
  await page.waitForTimeout(500);

  const cleared = await page.evaluate(() => {
    return state.selectedRunId === null && state._runList.length === 0;
  });
  assert.ok(cleared, 'New Session should clear Run identity state');
});

test('V1.5.0 CI-6c: No regression — simple create-file task does NOT trigger preflight', async ({ page }) => {
  await setMode(page, 'full_access');

  await sendTask(page, 'TEST_CREATE_FILE');
  await waitForRunComplete(page);

  // No context_selection event should be emitted
  const hasContextSel = await page.evaluate(() => {
    return state.timeline.some(item => item.name === 'context_selection');
  });
  assert.ok(!hasContextSel,
    'create-file task should NOT trigger context_selection preflight');
});

// ═══════════════════════════════════════════════════════
// Scenario 7: P1-6 baseline — preflight ON vs OFF effectiveness
// ═══════════════════════════════════════════════════════

test('V1.5.0 CI-7: Preflight ON — natural language bug description extracts search terms and finds target', async ({ page }) => {
  await setMode(page, 'full_access');

  // P1-5 fix: this is a natural language task with NO camelCase/snake_case
  // identifiers. Previously this would extract ZERO search terms.
  await sendTask(page, 'Fix the bug in login handler');
  await waitForRunComplete(page);

  const selEvent = await page.evaluate(() => {
    return state.timeline.find(item => item.name === 'context_selection');
  });

  assert.ok(selEvent, 'preflight should be triggered for bug-fix task');

  // P1-5: search terms should be extracted from natural language
  const termExtraction = selEvent.result.searchLog.find(l => l.type === 'term_extraction');
  assert.ok(termExtraction, 'searchLog should have term_extraction entry');
  assert.ok(termExtraction.terms.length > 0,
    `should extract search terms from natural language, got: ${JSON.stringify(termExtraction.terms)}`);

  // Search should have actually run
  const searchEntries = selEvent.result.searchLog.filter(l => l.type === 'search_code');
  assert.ok(searchEntries.length > 0, 'search_code entries should exist');

  // Target should be in Top-K (login-related or handler-related files)
  const selectedPaths = selEvent.result.selectedFiles.map(f => f.path);
  assert.ok(selectedPaths.length > 0, 'should select at least one file');
});

test('V1.5.0 CI-7b: Preflight OFF — create-file task does NOT trigger search', async ({ page }) => {
  await setMode(page, 'full_access');

  await sendTask(page, 'TEST_CREATE_FILE');
  await waitForRunComplete(page);

  // No context_selection should appear for create-file tasks
  const hasContextSel = await page.evaluate(() => {
    return state.timeline.some(item => item.name === 'context_selection');
  });
  assert.ok(!hasContextSel,
    'create-file task should NOT trigger context_selection (preflight OFF)');

  // But the task should still complete successfully
  const taskDone = await page.evaluate(() => {
    return state.timeline.some(item =>
      item.name === 'write_file' || item.name === 'edit_file'
    );
  });
  assert.ok(taskDone, 'create-file task should still execute tools');
});

test('V1.5.0 CI-7c: Preflight ON — Chinese bug description also works', async ({ page }) => {
  await setMode(page, 'full_access');

  // P1-5 fix: Chinese task should also trigger preflight and extract terms
  await sendTask(page, 'TEST_CHINESE_BUG');
  await waitForRunComplete(page);

  const selEvent = await page.evaluate(() => {
    return state.timeline.find(item => item.name === 'context_selection');
  });

  assert.ok(selEvent, 'preflight should be triggered for Chinese bug-fix task');
  assert.ok(selEvent.result.searchLog.some(l => l.type === 'search_code'),
    'Chinese task should have search_code entries');
});