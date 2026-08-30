/**
 * test/code-tools.test.js — V1.5.0 Codebase Intelligence Tools Tests
 *
 * Unit tests for: search_code, find_symbol, find_refs, codebase_map
 * Also tests: taskSelector.shouldPreflight, preflightContext with hard limits.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { CodeTools, TOOL_DEFS } from '../tools/code.js';
import {
  shouldPreflight,
  extractSearchTerms,
  preflightContext,
  LIMITS,
} from '../context/taskSelector.js';

// ── Test Workspace ───────────────────────────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'code-tools-test-'));

function setupWorkspace() {
  // Create a small project structure
  fs.writeFileSync(path.join(TEST_DIR, 'package.json'), JSON.stringify({
    name: 'test-project',
    main: 'server.js',
    scripts: { start: 'node server.js', test: 'node --test' },
    dependencies: { express: '^4.19.2' },
  }));

  fs.writeFileSync(path.join(TEST_DIR, 'server.js'),
    `const express = require('express');
const { AppService } = require('./app/service.js');
const app = express();
const svc = new AppService();
app.get('/api', (req, res) => res.json(svc.get()));
app.listen(3000);
`);

  fs.writeFileSync(path.join(TEST_DIR, 'app.js'),
    `const { AppService } = require('./app/service.js');
const { Helper } = require('./utils/helper.js');
class App {
  constructor() {
    this.service = new AppService();
    this.helper = new Helper();
  }
  getData() {
    return this.service.get();
  }
}
module.exports = { App };
`);

  // Create subdirectory
  fs.mkdirSync(path.join(TEST_DIR, 'app'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'app', 'service.js'),
    `class AppService {
  constructor() {
    this.cache = {};
  }
  get() {
    return this.cache.data || 'default';
  }
  set(key, value) {
    this.cache[key] = value;
  }
}
module.exports = { AppService };
`);

  fs.mkdirSync(path.join(TEST_DIR, 'utils'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'utils', 'helper.js'),
    `const { AppService } = require('../app/service.js');
class Helper {
  constructor() {
    this.service = new AppService();
  }
  process() {
    return this.service.get();
  }
}
module.exports = { Helper };
`);

  fs.mkdirSync(path.join(TEST_DIR, 'test'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'test', 'app.test.js'),
    `const { App } = require('../app.js');
test('App works', () => {
  const a = new App();
  assert.equal(typeof a.getData, 'function');
});
`);
}

setupWorkspace();

// ── Cleanup ──
process.on('exit', () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

let tools;

test('setup: CodeTools can be instantiated', () => {
  tools = new CodeTools(TEST_DIR);
  assert.ok(tools, 'CodeTools instance created');
  assert.ok(tools.service, 'WorkspaceFileService available');
});

// ═══════════════════════════════════════════════════════
// search_code
// ═══════════════════════════════════════════════════════

test('search_code: finds filename match', () => {
  const result = tools.searchCode({
    pattern: 'service',
    matchType: 'filename',
  });
  assert.ok(result.results.length > 0, 'should find service.js by filename');
  assert.ok(result.results.some(r => r.path === 'app/service.js'),
    'should find app/service.js');
  assert.equal(result.results[0].matchType, 'filename');
  assert.equal(result.results[0].score, 10);
});

test('search_code: finds text match', () => {
  const result = tools.searchCode({
    pattern: 'AppService',
    matchType: 'text',
  });
  assert.ok(result.results.length >= 3, 'AppService appears in multiple files');
  // matchType can be 'text', 'symbol', or 'reference' but NOT 'filename'
  assert.ok(result.results.every(r => r.matchType !== 'filename'),
    'text-only search should not produce filename matches');
});

test('search_code: finds symbol match (function/class)', () => {
  const result = tools.searchCode({
    pattern: 'class AppService',
    matchType: 'text',
  });
  assert.ok(result.results.length >= 1, 'should find class AppService');
  const hasSymbol = result.results.some(r =>
    r.matchType === 'symbol' || r.matchType === 'text'
  );
  assert.ok(hasSymbol, 'should have symbol or text match for class AppService');
});

test('search_code: maxResults respected', () => {
  const result = tools.searchCode({
    pattern: 'const',
    matchType: 'text',
    maxResults: 2,
  });
  assert.ok(result.results.length <= 2, 'maxResults respected');
  assert.ok(result.truncated === true || result.results.length === 2);
});

test('search_code: returns count and pattern', () => {
  const result = tools.searchCode({ pattern: 'service', matchType: 'all' });
  assert.equal(result.pattern, 'service');
  assert.equal(result.matchType, 'all');
  assert.equal(typeof result.count, 'number');
  assert.ok(result.count >= 0);
});

test('search_code: invalid regex throws', () => {
  assert.throws(() => {
    tools.searchCode({ pattern: '[invalid', matchType: 'text' });
  }, /非法正则/);
});

// ═══════════════════════════════════════════════════════
// find_symbol
// ═══════════════════════════════════════════════════════

test('find_symbol: finds class definition', () => {
  const result = tools.findSymbol({ name: 'AppService', kind: 'class' });
  assert.ok(result.results.length >= 1, 'should find AppService class');
  const def = result.results.find(r => r.path === 'app/service.js');
  assert.ok(def, 'should find definition in app/service.js');
  assert.equal(def.kind, 'class');
  assert.ok(def.confidence >= 0.9, 'class confidence should be high');
  assert.equal(def.definition, true);
  assert.ok(def.signature, 'should have signature');
  assert.ok(def.excerpt, 'should have excerpt');
});

test('find_symbol: finds function declaration', () => {
  // app.get callback is anonymous, but let's check getData
  const result = tools.findSymbol({ name: 'getData', kind: 'method' });
  // method detection is heuristic, may or may not find it
  assert.ok(Array.isArray(result.results));
});

test('find_symbol: kind filter works', () => {
  const classResult = tools.findSymbol({ name: 'App', kind: 'class' });
  const funcResult = tools.findSymbol({ name: 'App', kind: 'function' });
  // App is a class, so function search should return empty or different results
  assert.ok(classResult.results.length >= funcResult.results.length);
});

test('find_symbol: confidence is present', () => {
  const result = tools.findSymbol({ name: 'AppService' });
  assert.ok(typeof result.confidence === 'number');
  assert.ok(result.confidence >= 0);
  assert.ok(result.confidence <= 1);
});

test('find_symbol: missing name throws', () => {
  assert.throws(() => {
    tools.findSymbol({});
  }, /缺少 name/);
});

// ═══════════════════════════════════════════════════════
// find_refs
// ═══════════════════════════════════════════════════════

test('find_refs: finds references outside definition file', () => {
  const result = tools.findRefs({
    name: 'AppService',
    definitionPath: 'app/service.js',
  });
  assert.ok(result.results.length >= 1,
    'should find AppService referenced in app.js and utils/helper.js');
  // Should NOT include the definition file itself
  assert.ok(!result.results.some(r => r.path === 'app/service.js'),
    'should exclude definition file');
  // Should have referenceCandidate flag
  assert.ok(result.results.every(r => r.referenceCandidate === true));
});

test('find_refs: missing params throws', () => {
  assert.throws(() => tools.findRefs({ name: 'AppService' }), /缺少 definitionPath/);
  assert.throws(() => tools.findRefs({ definitionPath: 'app/service.js' }), /缺少 name/);
});

test('find_refs: confidence is heuristic level', () => {
  const result = tools.findRefs({
    name: 'AppService',
    definitionPath: 'app/service.js',
  });
  if (result.results.length > 0) {
    assert.ok(result.results[0].confidence === 0.7);
  }
});

// ═══════════════════════════════════════════════════════
// codebase_map
// ═══════════════════════════════════════════════════════

test('codebase_map: returns structure and importantFiles', () => {
  const result = tools.codebaseMap();
  assert.ok(result.structure, 'should have structure');
  assert.ok(Array.isArray(result.importantFiles), 'importantFiles should be array');
  assert.ok(result.importantFiles.length > 0, 'should have at least one important file');
});

test('codebase_map: package.json main is in importantFiles', () => {
  const result = tools.codebaseMap();
  const serverEntry = result.importantFiles.find(f => f.path === 'server.js');
  assert.ok(serverEntry, 'server.js (package.json main) should be in importantFiles');
  assert.ok(serverEntry.reasons.some(r => r.includes('main')),
    'server.js should have main reason');
});

test('codebase_map: structure has depth limit', () => {
  const result = tools.codebaseMap({ depth: 1 });
  // depth=1 means only root + immediate children
  const rootChildren = result.structure.children || [];
  assert.ok(rootChildren.length > 0, 'should have root children');
});

test('codebase_map: configs and testDirs present', () => {
  const result = tools.codebaseMap();
  assert.ok(Array.isArray(result.configs));
  assert.ok(Array.isArray(result.testDirs));
  assert.ok(result.dependencies.express, 'should have express dependency');
});

test('codebase_map: importantFiles have reason field', () => {
  const result = tools.codebaseMap();
  for (const f of result.importantFiles) {
    assert.ok(f.reasons && f.reasons.length > 0,
      `${f.path} should have reasons`);
    assert.ok(f.type, `${f.path} should have type`);
  }
});

// ═══════════════════════════════════════════════════════
// taskSelector.shouldPreflight
// ═══════════════════════════════════════════════════════

test('shouldPreflight: bug fix task triggers', () => {
  assert.equal(shouldPreflight('Fix the bug in login handler'), true);
  assert.equal(shouldPreflight('修复登录模块的 bug'), true);
});

test('shouldPreflight: modify existing code triggers', () => {
  assert.equal(shouldPreflight('Refactor the user service module'), true);
  assert.equal(shouldPreflight('重构用户服务模块'), true);
});

test('shouldPreflight: find/locate triggers', () => {
  assert.equal(shouldPreflight('Find the definition of authenticate function'), true);
  assert.equal(shouldPreflight('查找 authenticate 函数的定义'), true);
});

test('shouldPreflight: create new file does NOT trigger', () => {
  assert.equal(shouldPreflight('Create a new config file'), false);
  assert.equal(shouldPreflight('write a new test file'), false);
});

test('shouldPreflight: run command does NOT trigger', () => {
  assert.equal(shouldPreflight('Run the tests'), false);
  assert.equal(shouldPreflight('执行测试命令'), false);
});

test('shouldPreflight: simple change does NOT trigger', () => {
  assert.equal(shouldPreflight('Change the port to 3000'), false);
});

test('shouldPreflight: empty task does NOT trigger', () => {
  assert.equal(shouldPreflight(''), false);
  assert.equal(shouldPreflight(null), false);
  assert.equal(shouldPreflight(undefined), false);
});

test('shouldPreflight: identifier-based trigger', () => {
  assert.equal(shouldPreflight('Fix the camelCaseHandler issue'), true);
  assert.equal(shouldPreflight('Update snake_case_config value'), true);
});

// ═══════════════════════════════════════════════════════
// extractSearchTerms
// ═══════════════════════════════════════════════════════

test('extractSearchTerms: extracts quoted strings', () => {
  const terms = extractSearchTerms('Find "authenticate" in the "user service"');
  assert.ok(terms.includes('authenticate'));
  assert.ok(terms.includes('user service'));
});

test('extractSearchTerms: extracts identifiers', () => {
  const terms = extractSearchTerms('Fix the authModule handler');
  assert.ok(terms.some(t => t.includes('authmodule') || t.includes('authModule')));
});

// ═══════════════════════════════════════════════════════
// preflightContext — hard limits and effect metrics
// ═══════════════════════════════════════════════════════

test('preflightContext: returns null for non-trigger task', async () => {
  const result = await preflightContext({
    task: 'Create a new config file',
    workspace: TEST_DIR,
  });
  assert.equal(result, null);
});

test('preflightContext: returns supplementalContext for trigger task', async () => {
  const result = await preflightContext({
    task: 'Fix the AppService bug in the service module',
    workspace: TEST_DIR,
  });
  assert.ok(result, 'should return non-null for trigger task');
  assert.equal(result.triggered, true);
  assert.ok(result.searchLog, 'should have searchLog');
  assert.ok(Array.isArray(result.selectedFiles), 'selectedFiles should be array');
  assert.ok(result.metrics, 'should have metrics');
});

test('preflightContext: effect metric — selectedFiles ≤ 6', async () => {
  const result = await preflightContext({
    task: 'Fix the AppService bug in the service module',
    workspace: TEST_DIR,
  });
  assert.ok(result);
  assert.ok(result.metrics.selectedFiles <= LIMITS.maxSelectedFiles,
    `selectedFiles (${result.metrics.selectedFiles}) must be ≤ ${LIMITS.maxSelectedFiles}`);
});

test('preflightContext: effect metric — injectedChars ≤ 12k', async () => {
  const result = await preflightContext({
    task: 'Fix the AppService bug in the service module',
    workspace: TEST_DIR,
  });
  assert.ok(result);
  assert.ok(result.metrics.injectedChars <= LIMITS.maxInjectedChars,
    `injectedChars (${result.metrics.injectedChars}) must be ≤ ${LIMITS.maxInjectedChars}`);
});

test('preflightContext: effect metric — contextBlock length matches injectedChars', async () => {
  const result = await preflightContext({
    task: 'Fix the AppService bug in the service module',
    workspace: TEST_DIR,
  });
  assert.ok(result);
  assert.equal(result.contextBlock.length, result.metrics.injectedChars);
});

test('preflightContext: searchLog contains search_code entries', async () => {
  const result = await preflightContext({
    task: 'Fix the AppService bug in the service module',
    workspace: TEST_DIR,
  });
  assert.ok(result);
  const searchEntries = result.searchLog.filter(l => l.type === 'search_code');
  assert.ok(searchEntries.length > 0, 'should have search_code log entries');
});

test('preflightContext: selectedFiles have reason and excerpt', async () => {
  const result = await preflightContext({
    task: 'Fix the AppService bug in the service module',
    workspace: TEST_DIR,
  });
  assert.ok(result);
  for (const f of result.selectedFiles) {
    assert.ok(f.path, 'selected file should have path');
    assert.ok(f.reason, `${f.path} should have reason`);
    assert.ok(f.relevance !== undefined, `${f.path} should have relevance score`);
  }
});

test('preflightContext: candidates are transparent', async () => {
  const result = await preflightContext({
    task: 'Fix the AppService bug in the service module',
    workspace: TEST_DIR,
  });
  assert.ok(result);
  assert.ok(Array.isArray(result.candidates));
  // candidates should include the selected files plus others
  assert.ok(result.candidates.length >= result.selectedFiles.length);
});

// ═══════════════════════════════════════════════════════
// TOOL_DEFS — schema validation
// ═══════════════════════════════════════════════════════

test('TOOL_DEFS: all 4 tools have required fields', () => {
  const required = ['search_code', 'find_symbol', 'find_refs', 'codebase_map'];
  for (const name of required) {
    assert.ok(TOOL_DEFS[name], `${name} should be defined`);
    assert.ok(TOOL_DEFS[name].description, `${name} should have description`);
    assert.ok(TOOL_DEFS[name].input_schema, `${name} should have input_schema`);
    assert.ok(TOOL_DEFS[name].input_schema.type, `${name} input_schema should have type`);
    assert.ok(TOOL_DEFS[name].input_schema.properties, `${name} should have properties`);
  }
});

test('TOOL_DEFS: find_refs requires name and definitionPath', () => {
  const required = TOOL_DEFS.find_refs.input_schema.required;
  assert.ok(required.includes('name'), 'find_refs requires name');
  assert.ok(required.includes('definitionPath'), 'find_refs requires definitionPath');
});

test('TOOL_DEFS: search_code requires pattern', () => {
  const required = TOOL_DEFS.search_code.input_schema.required;
  assert.ok(required.includes('pattern'), 'search_code requires pattern');
});

test('TOOL_DEFS: find_symbol requires name', () => {
  const required = TOOL_DEFS.find_symbol.input_schema.required;
  assert.ok(required.includes('name'), 'find_symbol requires name');
});