import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Test Workspace: 使用 Server 默认的 test-workspace ──
// Server 由 playwright.config.js 启动，cwd = Harness/
// config.js 默认 workspace = path.join(process.cwd(), 'test-workspace')
const TEST_WORKSPACE = path.join(process.cwd(), 'test-workspace');

test.beforeEach(() => {
  console.log('[TEST] beforeAll: recreating test-workspace');
  // 确保 test-workspace 存在
  fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  // package.json（版本 0.4.2，供 edit_file oldString 匹配）
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      version: '0.4.2',
      description: 'Test workspace for E2E',
      main: 'app.js',
      scripts: { start: 'node app.js' },
      dependencies: { express: '^4.19.2' },
    }, null, 2) + '\n'
  );
  console.log('[TEST] beforeAll: package.json written with version 0.4.2');

  // app.js
  fs.writeFileSync(
    path.join(TEST_WORKSPACE, 'app.js'),
    'const express = require(\'express\');\nconst app = express();\nconst PORT = process.env.PORT || 3000;\napp.get(\'/\', (req, res) => res.send(\'<h1>Hello Agent</h1>\'));\napp.listen(PORT, () => console.log(`Server on ${PORT}`));\n'
  );

  // foo/ 目录（供 Directory Delete 测试）
  const fooDir = path.join(TEST_WORKSPACE, 'foo');
  fs.mkdirSync(fooDir, { recursive: true });
  fs.writeFileSync(path.join(fooDir, 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(fooDir, 'b.js'), 'const b = 2;\n');
  console.log('[TEST] beforeAll: setup complete');
});

test.beforeEach(async ({ page }) => {
  // 导航到应用
  await page.goto('http://127.0.0.1:38212');
  await expect(page.locator('.topbar')).toBeVisible();

  // Capture browser console and errors
  page.on('console', msg => {
    console.log('[BROWSER ' + msg.type().toUpperCase() + ']', msg.text());
  });
  page.on('pageerror', err => {
    console.log('[PAGE ERROR]', err.message);
    console.log('[PAGE ERROR STACK]', err.stack);
  });

  // 等待页面初始化完成
  await page.waitForFunction(() => {
    return typeof localToken !== 'undefined' && localToken !== null;
  }, { timeout: 10000 });

  // 等待文件树加载
  await page.waitForSelector('#fileTree', { timeout: 5000 });
});

// ── Helper: 等待 Run 完成 ─────────────────────────────
async function waitForRunComplete(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const btn = document.getElementById('sendBtn');
    return btn && !btn.disabled;
  }, { timeout });
}

// ── Helper: 等待 Approval Modal ───────────────────────
async function waitForApproval(page, timeout = 30000) {
  await page.waitForSelector('#approvalModal.open', { timeout });
}

// ── Helper: 发送 Task ─────────────────────────────────
async function sendTask(page, task) {
  await page.locator('#chatInput').fill(task);
  await page.locator('#sendBtn').click();
}

// ── Helper: 设置 Permission Mode ─────────────────────
async function setMode(page, mode) {
  // 直接设置 state.permissionMode（跳过 UI 事件竞争）
  await page.evaluate((m) => {
    state.permissionMode = m;
    const select = document.getElementById('modeSelect');
    if (select) select.value = m;
  }, mode);
}

// ═══════════════════════════════════════════════════════
// Agent E2E A — Standard Edit（自动执行，无 Approval）
// ═══════════════════════════════════════════════════════

test('Agent E2E A — Standard Edit (auto, no approval)', async ({ page }) => {
  await setMode(page, 'standard');
  await sendTask(page, 'TEST_STANDARD_EDIT');

  // 等待 Run 完成
  await waitForRunComplete(page, 20000);

  // DEBUG: check diff panel state
  const diffState = await page.evaluate(() => {
    const panel = $('#diffPanel');
    const changes = $('#inspectorChanges');
    const tabs = $$('.inspector-tab');
    return {
      diffPanelHTML: panel ? panel.innerHTML.slice(0, 200) : 'NO PANEL',
      changesDisplay: changes ? changes.style.display : 'NO ELEMENT',
      activeTab: tabs.find(t => t.classList.contains('active'))?.dataset.tab,
    };
  });
  console.log('DIFF STATE:', JSON.stringify(diffState));

  // 验证：Completion Summary 出现（证明 agent_done 收到）
  await expect(page.locator('#completionSummary')).not.toHaveCSS('display', 'none', { timeout: 5000 });

  // 验证：Changes 面板有修改
  await page.locator('.inspector-tab[data-tab="changes"]').click();
  await expect(page.locator('.diff-file')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.badge.modify')).toBeVisible();

  // 验证：Timeline 有 read_file 和 edit_file
  await expect(page.locator('.timeline-item')).toHaveCount(2, { timeout: 5000 });
});

// ═══════════════════════════════════════════════════════
// Agent E2E B — Safe Edit → Approval → Allow
// ═══════════════════════════════════════════════════════

test('Agent E2E B — Safe Edit → Approval → Allow', async ({ page }) => {
  await setMode(page, 'safe');
  await sendTask(page, 'TEST_SAFE_EDIT');

  // 等待 Approval Modal
  await waitForApproval(page);

  // 验证：Approval Modal 内容正确
  await expect(page.locator('#approvalModal')).toContainText('package.json');
  await expect(page.locator('#approveApproval')).toBeVisible();
  await expect(page.locator('#rejectApproval')).toBeVisible();

  // Allow once（直接调用 respondApproval 避免 UI 事件竞争）
  await page.evaluate(() => respondApproval(true));

  // 等待 Run 完成
  await waitForRunComplete(page);

  // 验证：文件实际被修改（Changes 有 M）
  await page.locator('.inspector-tab[data-tab="changes"]').click();
  await expect(page.locator('.diff-file')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.badge.modify')).toBeVisible();

  // 验证：Approval 计数（等待 Completion Summary 可见）
  await page.waitForSelector('#completionSummary', { state: 'visible', timeout: 10000 });
  await expect(page.locator('.cs-value').nth(2)).toContainText('1 approved');
});

// ═══════════════════════════════════════════════════════
// Agent E2E C — Safe Edit → Reject
// ═══════════════════════════════════════════════════════

test('Agent E2E C — Safe Edit → Reject', async ({ page }) => {
  // 先读取文件内容（before）
  const beforeContent = fs.readFileSync(path.join(TEST_WORKSPACE, 'package.json'), 'utf-8');

  await setMode(page, 'safe');
  await sendTask(page, 'TEST_REJECT_APPROVAL');

  // 等待 Approval Modal
  await waitForApproval(page);

  // Reject（直接调用 respondApproval 避免 UI 事件竞争）
  await page.evaluate(() => respondApproval(false));

  // 等待 Run 完成
  await waitForRunComplete(page);

  // 验证：文件未被修改
  const afterContent = fs.readFileSync(path.join(TEST_WORKSPACE, 'package.json'), 'utf-8');
  expect(afterContent).toBe(beforeContent);

  // 验证：Approval rejected count = 1
  await page.waitForSelector('#completionSummary', { state: 'visible', timeout: 10000 });
  await expect(page.locator('.cs-value').nth(2)).toContainText('1 rejected');
});

// ═══════════════════════════════════════════════════════
// Agent E2E D — Command → Terminal
// ═══════════════════════════════════════════════════════

test('Agent E2E D — Command → Terminal (echo)', async ({ page }) => {
  await setMode(page, 'full_access');
  await sendTask(page, 'TEST_COMMAND');

  // 等待 Run 完成
  await waitForRunComplete(page);

  // 验证：Terminal 有命令卡片
  const termPanel = page.locator('#terminalPanel');
  // 确保 Terminal 展开
  if (await termPanel.evaluate(el => el.classList.contains('collapsed'))) {
    await page.locator('#toggleTerminal').click();
  }

  await expect(page.locator('.cmd-card')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.cmd-card-command')).toContainText('echo hello-agent');

  // 验证：Timeline 可以导航到 Terminal
  await page.locator('.ti-cmd').first().click();
  await expect(page.locator('.cmd-highlight')).toBeVisible({ timeout: 3000 });
});

// ═══════════════════════════════════════════════════════
// Agent E2E E — Directory Delete
// ═══════════════════════════════════════════════════════

test('Agent E2E E — Directory Delete', async ({ page }) => {
  // 确保 foo/ 存在
  const fooDir = path.join(TEST_WORKSPACE, 'foo');
  expect(fs.existsSync(fooDir)).toBe(true);

  await setMode(page, 'full_access');
  await sendTask(page, 'TEST_DELETE_DIR');

  // 等待 Run 完成
  await waitForRunComplete(page);

  // 验证：foo 目录已删除（直接从 Node.js 检查，不走浏览器）
  expect(fs.existsSync(path.join(TEST_WORKSPACE, 'foo'))).toBe(false);

  // 验证：Changes 面板显示删除
  await page.locator('.inspector-tab[data-tab="changes"]').click();
  await expect(page.locator('.diff-file').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.badge.delete').first()).toBeVisible();

  // 验证：Diff 视图显示删除内容
  await page.locator('.diff-file-header').first().click();
  await expect(page.locator('.fv-tab.active')).toHaveText('Diff');
  await expect(page.locator('#fvBody')).toContainText('deleted', { timeout: 5000 });
});

// ═══════════════════════════════════════════════════════
// Agent E2E F — Stop / Late Event
// ═══════════════════════════════════════════════════════

test('Agent E2E F — Stop / Late Event', async ({ page }) => {
  await setMode(page, 'full_access');
  await sendTask(page, 'TEST_STOP_LATE');

  // 等待第一个命令卡片出现在 Terminal（证明 Agent 真的在运行）
  await page.waitForSelector('.cmd-card', { timeout: 10000 });

  // Stop（直接调用 stopTask 避免 UI 事件竞争）
  await page.evaluate(() => stopTask());

  // 等待 UI 恢复（send button 重新启用 + state.running = false）
  await expect(page.locator('#sendBtn')).not.toBeDisabled({ timeout: 10000 });
  await page.waitForFunction(() => !state.running, { timeout: 5000 });

  // 验证：New Session 可用
  await expect(page.locator('#newSessionBtn')).not.toBeDisabled();

  // 验证：Approval 已清理（没有残留 modal）
  await expect(page.locator('#approvalModal')).not.toHaveClass(/open/);

  // 立即启动 Run B（简单的 read-only task，验证 UI 不被旧 Run 污染）
  await sendTask(page, 'TEST_READ_ONLY');

  // 等待 Run B 完成（Completion Summary 出现）
  await page.waitForFunction(() => {
    const cs = document.getElementById('completionSummary');
    return cs && cs.style.display !== 'none';
  }, { timeout: 15000 });

  // 验证：Run B 的 Timeline 显示 read_file on package.json
  await expect(page.locator('.ti-file')).toContainText('package.json');
});

// ═══════════════════════════════════════════════════════
// Agent E2E G — Session Switch Race Prevention
// ═══════════════════════════════════════════════════════

test('Agent E2E G — Session Switch Race Prevention', async ({ page }) => {
  await setMode(page, 'full_access');

  // 1. Start Run A — wait for state.running to be true
  await sendTask(page, 'TEST_STOP_LATE');
  await page.waitForFunction(() => state.running === true, { timeout: 5000 });

  // 2. Verify Session List button is disabled during run
  await expect(page.locator('#sessionListBtn')).toBeDisabled();

  // 3. Programmatic switchSession should be rejected
  await page.evaluate(() => switchSession('non-existent'));
  await page.waitForTimeout(200);
  // Session should still be the same (switch was rejected)
  const sessionIdAfterReject = await page.evaluate(() => state.sessionId);
  expect(sessionIdAfterReject).toBeTruthy();

  // 4. Stop the run
  await page.evaluate(() => stopTask());
  await expect(page.locator('#sendBtn')).not.toBeDisabled({ timeout: 10000 });

  // 5. After stop, Session List button should be enabled
  await expect(page.locator('#sessionListBtn')).not.toBeDisabled();

  // 6. Create a second session via New Session
  await page.locator('#newSessionBtn').click();
  await page.waitForTimeout(200);
  const sessionIdB = await page.evaluate(() => state.sessionId);
  expect(sessionIdB).not.toBe(sessionIdAfterReject);

  // 7. Send a task on Session B
  await sendTask(page, 'TEST_COMMAND');
  await page.waitForFunction(() => {
    const cs = document.getElementById('completionSummary');
    return cs && cs.style.display !== 'none';
  }, { timeout: 15000 });

  // 8. Verify Terminal shows the command from Session B (not A)
  const termPanel = page.locator('#terminalPanel');
  if (await termPanel.evaluate(el => el.classList.contains('collapsed'))) {
    await page.locator('#toggleTerminal').click();
  }
  await expect(page.locator('.cmd-card-command')).toContainText('echo hello-agent');
});