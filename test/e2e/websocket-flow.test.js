import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:38212');
});

// ── E2E 1: App Startup ──────────────────────────────

test('E2E 1 — App Startup', async ({ page }) => {
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('#fileTree')).toBeVisible();
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(page.locator('#terminalPanel')).toBeVisible();
  await expect(page.locator('#modeSelect')).toHaveValue('standard');
});

// ── E2E 2: Deep Explorer ────────────────────────────

test('E2E 2 — Deep Explorer', async ({ page }) => {
  const rootToggle = page.locator('#fileTree [data-toggle="."]').first();
  if (await rootToggle.count() > 0) {
    await rootToggle.click();
  }
  await page.waitForSelector('.tree-row', { timeout: 5000 });
  await expect(page.locator('.tree-row').first()).toBeVisible();
});

// ── E2E 3: File → Inspector ─────────────────────────

test('E2E 3 — File → Inspector', async ({ page }) => {
  await page.waitForFunction('window.__dshTest !== undefined');
  // Use test hook to directly open a file in Inspector
  await page.evaluate(() => {
    window.__dshTest.openFile('package.json');
  });
  // Verify Inspector shows the file
  await expect(page.locator('#inspectorFile')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.fv-tab.active')).toHaveText('Current', { timeout: 5000 });
  await expect(page.locator('#fvPath')).toContainText('package.json', { timeout: 5000 });
});

// ── E2E 4: Changes → Diff ───────────────────────────

test('E2E 4 — Changes → Diff', async ({ page }) => {
  await page.evaluate(() => {
    window.__dshTest.setChanges([{
      path: 'test-file.js', type: 'modify', added: 5, removed: 2,
      diff: [{ type: 'remove', content: 'old line' }, { type: 'add', content: 'new line' }],
      before: 'old line\n', after: 'new line\n',
    }]);
  });
  await page.locator('.inspector-tab[data-tab="changes"]').click();
  await expect(page.locator('.diff-file')).toBeVisible();
  await page.locator('.diff-file-header').first().click();
  await expect(page.locator('.fv-tab.active')).toHaveText('Diff');
});

// ── E2E 5: Deleted File ─────────────────────────────

test('E2E 5 — Deleted File', async ({ page }) => {
  await page.evaluate(() => {
    window.__dshTest.setChanges([{
      path: 'legacy.js', type: 'delete', added: 0, removed: 3,
      diff: [], before: 'const a = 1;\n', after: '',
    }]);
  });
  await page.locator('.inspector-tab[data-tab="changes"]').click();
  await expect(page.locator('.diff-file')).toBeVisible();
  await page.locator('.diff-file-header').first().click();
  await expect(page.locator('#fvBody')).toContainText('deleted');
});

// ── E2E 6: Timeline → File ──────────────────────────

test('E2E 6 — Timeline → File', async ({ page }) => {
  await page.evaluate(() => {
    window.__dshTest.setTimeline([{
      id: 'tc-test-1', name: 'read_file',
      args: { path: 'package.json' }, status: 'done',
      startTime: Date.now() - 100, duration: 100,
      result: { path: 'package.json' },
    }]);
  });
  await page.locator('.ti-file-link').first().click();
  await expect(page.locator('#inspectorFile')).toBeVisible();
  await expect(page.locator('#fvPath')).toContainText('package.json');
});

// ── E2E 7: Timeline → Terminal ──────────────────────

test('E2E 7 — Timeline → Terminal', async ({ page }) => {
  await page.evaluate(() => {
    window.__dshTest.setTimeline([{
      id: 'tc-test-cmd', name: 'run_command',
      args: { command: 'echo hello' }, status: 'done',
      startTime: Date.now() - 100, duration: 100,
      result: { exitCode: 0, stdout: 'hello\n', toolCallId: 'tc-test-cmd' },
    }]);
    window.__dshTest.setTerminal([{
      toolCallId: 'tc-test-cmd', command: 'echo hello', stdout: 'hello\n',
    }]);
  });
  await page.locator('.ti-cmd').first().click();
  await expect(page.locator('#terminalPanel')).not.toHaveClass('collapsed');
  await expect(page.locator('.cmd-highlight')).toBeVisible();
});

// ── E2E 8: Duplicate Command Identity ───────────────

test('E2E 8 — Duplicate Command Identity', async ({ page }) => {
  await page.evaluate(() => {
    window.__dshTest.setTimeline([
      { id: 'cmd-first', name: 'run_command', args: { command: 'npm test' },
        status: 'done', startTime: 0, duration: 100,
        result: { exitCode: 0, stdout: 'first', toolCallId: 'cmd-first' } },
      { id: 'cmd-second', name: 'run_command', args: { command: 'npm test' },
        status: 'done', startTime: 0, duration: 100,
        result: { exitCode: 0, stdout: 'second', toolCallId: 'cmd-second' } },
    ]);
    window.__dshTest.setTerminal([
      { toolCallId: 'cmd-first', command: 'npm test', stdout: 'first' },
      { toolCallId: 'cmd-second', command: 'npm test', stdout: 'second' },
    ]);
  });
  // Ensure terminal is visible
  const termPanel = page.locator('#terminalPanel');
  if (await termPanel.count() > 0) {
    const isVisible = await termPanel.evaluate(el => !el.classList.contains('collapsed'));
    if (!isVisible) {
      await page.locator('#toggleTerminal').click();
    }
  }
  // Click first command in timeline
  await page.locator('.ti-cmd').first().click();
  await page.waitForTimeout(200);
  // Verify first card is highlighted
  const firstCard = page.locator('.cmd-card[data-tool-call-id="cmd-first"]');
  await expect(firstCard).toHaveClass(/cmd-highlight/);
  // Click second command
  await page.locator('.ti-cmd').nth(1).click();
  await page.waitForTimeout(200);
  // Verify second card is highlighted
  const secondCard = page.locator('.cmd-card[data-tool-call-id="cmd-second"]');
  await expect(secondCard).toHaveClass(/cmd-highlight/);
});

// ── E2E 9: Permission Mode ──────────────────────────

test('E2E 9 — Permission Mode', async ({ page }) => {
  await expect(page.locator('#modeSelect')).toHaveValue('standard');
  await page.locator('#modeSelect').selectOption('safe');
  await expect(page.locator('#modeSelect')).toHaveValue('safe');
  await page.locator('#modeSelect').selectOption('full_access');
  await expect(page.locator('#modeSelect')).toHaveValue('full_access');
  await page.locator('#modeSelect').selectOption('standard');
  await expect(page.locator('#modeSelect')).toHaveValue('standard');
});

// ── E2E 10: New Session ─────────────────────────────

test('E2E 10 — New Session', async ({ page }) => {
  await page.evaluate(() => {
    window.__dshTest.setTimeline([{ id: 'x', name: 'read_file', args: { path: 'a.js' }, status: 'done' }]);
  });
  await page.locator('#newSessionBtn').click();
  await expect(page.locator('#newSessionBtn')).not.toBeDisabled();
});

// ── E2E 11: Directory Delete Complete Flow ──────────────

test('E2E 11 — Directory Delete Complete Flow', async ({ page }) => {
  // Set up a directory delete scenario: timeline + changes
  await page.evaluate(() => {
    window.__dshTest.setTimeline([{
      id: 'tc-del-1', name: 'delete_file',
      args: { path: 'foo' }, status: 'done',
      startTime: Date.now() - 100, duration: 50,
      result: { action: 'deleted', wasDirectory: true,
        deletedFiles: [
          { path: 'foo/a.js', before: 'const a = 1;\n' },
          { path: 'foo/b.js', before: 'const b = 2;\n' },
        ] },
    }]);
    window.__dshTest.setChanges([{
      path: 'foo/a.js', type: 'delete', added: 0, removed: 1,
      diff: [{ type: 'remove', content: 'const a = 1;' }],
      before: 'const a = 1;\n', after: '',
    }]);
  });

  // 1. Timeline shows delete_file with trash icon and directory path
  await expect(page.locator('.ti-file')).toContainText('foo');
  await expect(page.locator('.ti-file')).toContainText('🗑');

  // 2. Changes panel shows delete badge (D) and file entry
  await page.locator('.inspector-tab[data-tab="changes"]').click();
  await expect(page.locator('.badge.delete')).toBeVisible();
  await expect(page.locator('.diff-file')).toContainText('foo/a.js');

  // 3. Click the deleted file entry in Changes → opens Inspector File tab with Diff view
  await page.locator('.diff-file-header').first().click();
  await expect(page.locator('#inspectorFile')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.fv-tab.active')).toHaveText('Diff');
  await expect(page.locator('#fvPath')).toContainText('foo/a.js');

  // 4. Diff view shows "File deleted in this run"
  await expect(page.locator('#fvBody')).toContainText('File deleted in this run');

  // 5. Click "View Diff" button → shows deleted content lines
  await page.locator('#viewDiffBtn').click();
  await expect(page.locator('.fv-diff-line.removed').first()).toContainText('const a = 1;');
});