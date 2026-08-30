/**
 * tools/code.js — V1.5.0 Codebase Intelligence Tools
 *
 * Lightweight code understanding without an index store or knowledge graph.
 * All tools reuse WorkspaceFileService + Sandbox for safe file access.
 *
 * Capabilities:
 *   search_code     — filename + text + symbol search
 *   find_symbol     — locate function/class/variable definitions (heuristic)
 *   find_refs       — find reference candidates for a symbol (heuristic)
 *   codebase_map    — lightweight project overview (importantFiles, not "core modules")
 *
 * NOT doing:
 *   - Full static analysis / call graph / type inference
 *   - LSP / IDE-level symbol resolution
 *   - Vector DB / semantic search
 *   - Whole-repo indexing
 */

import fs from 'fs';
import path from 'path';
import { WorkspaceFileService } from '../fileservice.js';

// ── Constants ────────────────────────────────────────────
const MAX_SEARCH_RESULTS = 50;
const MAX_SCAN_FILES = 300;
const MAX_SCAN_BYTES = 5 * 1024 * 1024; // 5 MB total scanned
const MAX_EXCERPT_CHARS = 200;
const MAX_SIGNATURE_CHARS = 120;

// ── Symbol Detection Patterns (JS/TS heuristic) ──────────
// P1-2 fix: ALL patterns capture the symbol name in group 1.
// Previous code used m[3] || m[2] which was wrong for method (m[1])
// and could capture 'async' for async const arrows.
const SYMBOL_PATTERNS = [
  // function declaration: function foo(a, b) {
  {
    name: 'function_decl',
    re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    kind: 'function',
    confidence: 0.95,
  },
  // class declaration: class Foo extends Bar {
  {
    name: 'class_decl',
    re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    kind: 'class',
    confidence: 0.95,
  },
  // const arrow: const foo = (a, b) => {
  {
    name: 'const_arrow',
    re: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\s*\(/,
    kind: 'variable',
    confidence: 0.85,
  },
  // const function: const foo = function(a, b) {
  {
    name: 'const_function',
    re: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(/,
    kind: 'variable',
    confidence: 0.85,
  },
  // let/var declaration
  {
    name: 'var_decl',
    re: /^\s*(?:export\s+)?(?:let|var)\s+(\w+)/,
    kind: 'variable',
    confidence: 0.7,
  },
  // method inside class: foo(a, b) {
  {
    name: 'method',
    re: /^\s+(\w+)\s*\([^)]*\)\s*{/,
    kind: 'method',
    confidence: 0.6,
  },
];

// ── Helpers ──────────────────────────────────────────────

/**
 * Walk workspace files, applying a callback.
 * Reuses the same skip rules as FileTools._walk().
 */
function walkWorkspace(service, root, budget, cb) {
  // P1-1 fix: walkWorkspace is the SOLE budget consumer.
  // taskSelector reads budget state but never adds to it — this
  // prevents double-counting (previously both walker AND caller added).
  // Signature: (service, root, budget, cb) — budget is 3rd, cb is 4th.
  const local = { files: 0, bytes: 0 };
  let truncated = false;

  function remaining() {
    if (!budget) {
      return { files: MAX_SCAN_FILES - local.files, bytes: MAX_SCAN_BYTES - local.bytes };
    }
    return {
      files: budget.maxFiles - budget.usedFiles - local.files,
      bytes: budget.maxBytes - budget.usedBytes - local.bytes,
    };
  }

  function checkBudget() {
    const r = remaining();
    return r.files > 0 && r.bytes > 0;
  }

  function walk(dir) {
    if (!checkBudget()) { truncated = true; return; }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!checkBudget()) { truncated = true; return; }
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const relPath = service.sandbox.relative(full);
        if (service.isSensitive(relPath)) continue;
        if (service.isBinary(relPath)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 1024 * 1024) continue;
          // P1-1 fix: check remainingBytes BEFORE consuming this file.
          // Without this check, a 500KB file when only 10KB budget remains
          // would still be fully scanned, making the limit soft.
          const r = remaining();
          if (stat.size > r.bytes) {
            truncated = true;
            return;
          }
          local.bytes += stat.size;
          local.files++;
          const result = cb(full, relPath, stat);
          if (result === false) return;
        } catch {
          // skip
        }
      }
    }
  }
  walk(root);

  // Consume from shared budget (if provided) — sole consumer
  if (budget) {
    budget.usedFiles += local.files;
    budget.usedBytes += local.bytes;
    if (budget.usedFiles >= budget.maxFiles || budget.usedBytes >= budget.maxBytes) {
      budget.exhausted = true;
    }
  }

  return { scannedFiles: local.files, scannedBytes: local.bytes, truncated };
}

/**
 * Extract symbols from file content using heuristic patterns.
 */
function extractSymbols(content, filePath) {
  const symbols = [];
  const lines = content.split('\n');
  let inClass = false;
  let classIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Track class context for method detection
    const classMatch = line.match(/^\s*(export\s+)?(abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      inClass = true;
      classIndent = line.match(/^(\s*)/)[1].length;
      symbols.push({
        path: filePath,
        line: lineNum,
        kind: 'class',
        name: classMatch[3],
        signature: line.trim().slice(0, MAX_SIGNATURE_CHARS),
        excerpt: lines.slice(i, Math.min(i + 3, lines.length)).join('\n').slice(0, MAX_EXCERPT_CHARS),
        confidence: 0.95,
        definition: true,
      });
      continue;
    }

    // Exit class context
    if (inClass) {
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (line.trim() && indent <= classIndent && !line.trim().startsWith('//')) {
        inClass = false;
      }
    }

    for (const pat of SYMBOL_PATTERNS) {
      const m = line.match(pat.re);
      if (m) {
        // P1-2 fix: all patterns capture name in group 1
        const name = m[1];
        if (!name) continue;

        // Skip method patterns if not in class
        if (pat.name === 'method' && !inClass) continue;

        // Skip if name looks like a keyword
        if (['if', 'for', 'while', 'switch', 'catch', 'function', 'class', 'return', 'typeof', 'new'].includes(name)) continue;

        const sig = line.trim().slice(0, MAX_SIGNATURE_CHARS);
        const excerpt = lines.slice(i, Math.min(i + 2, lines.length)).join('\n').slice(0, MAX_EXCERPT_CHARS);

        symbols.push({
          path: filePath,
          line: lineNum,
          kind: pat.kind,
          name,
          signature: sig,
          excerpt,
          confidence: pat.confidence,
          definition: true,
        });
        break; // one symbol per line
      }
    }
  }

  return symbols;
}

// ── Tools ────────────────────────────────────────────────

class CodeTools {
  constructor(workspace) {
    this.service = new WorkspaceFileService(workspace);
    this.root = this.service.sandbox.root;
  }

  /**
   * search_code — enhanced code search.
   *
   * @param {object} input
   * @param {string} input.pattern     — search keyword / regex
   * @param {string} [input.path]      — search scope (default root)
   * @param {string} [input.matchType] — 'all' | 'filename' | 'text' | 'symbol'
   * @param {number} [input.maxResults]
   * @returns {object}
   */
  searchCode(input, budget) {
    const { pattern, path: searchPath, matchType = 'all', maxResults = MAX_SEARCH_RESULTS } = input;
    if (!pattern) throw new Error('search_code 缺少 pattern 参数');

    const results = [];
    const limit = Math.min(maxResults, MAX_SEARCH_RESULTS);
    let regex = null;
    let filenamePattern = null;

    // Build regex for text/symbol search
    // P1-2 fix: 'symbol' matchType must also build the regex,
    // otherwise no results are produced (both regex and filenamePattern stay null).
    if (matchType === 'text' || matchType === 'all' || matchType === 'symbol') {
      try {
        regex = new RegExp(pattern, 'gi');
      } catch (err) {
        throw new Error(`非法正则表达式: ${pattern}. 错误: ${err.message}`);
      }
    }

    // Build filename pattern (simple substring match, no glob dep)
    if (matchType === 'filename' || matchType === 'all') {
      filenamePattern = pattern.toLowerCase();
    }

    const root = this.service.sandbox.resolve(searchPath || '.');
    const walkStats = walkWorkspace(this.service, root, budget, (fullPath, relPath, stat) => {
      if (results.length >= limit) return false;

      const fileName = path.basename(relPath).toLowerCase();

      // Filename match
      if (filenamePattern && fileName.includes(filenamePattern)) {
        // P1-2 fix: when matchType is 'symbol', skip filename-only matches
        if (matchType === 'symbol') return true;
        results.push({
          path: relPath,
          line: 0,
          content: fileName,
          matchType: 'filename',
          score: 10,
        });
        return true;
      }

      // Text/symbol match
      if (regex) {
        // Skip large files
        if (stat.size > 200 * 1024) return true;

        let content;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          return true;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) return false;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            // Determine match sub-type
            let mt = 'text';
            let score = 5;
            const trimmed = lines[i].trim();
            // Check if it's a symbol definition line
            for (const pat of SYMBOL_PATTERNS) {
              if (pat.re.test(trimmed)) {
                mt = 'symbol';
                score = 8;
                break;
              }
            }
            // Boost score for import/require lines (reference)
            if (/^\s*(import|require|from)\s/.test(trimmed)) {
              mt = 'reference';
              score = 6;
            }

            // P1-2 fix: when matchType is 'symbol', ONLY return symbol
            // definition matches — skip text/reference matches.
            if (matchType === 'symbol' && mt !== 'symbol') continue;

            results.push({
              path: relPath,
              line: i + 1,
              content: trimmed.slice(0, 300),
              matchType: mt,
              score,
            });
          }
        }
      }
      return true;
    });

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return {
      pattern,
      matchType,
      results,
      count: results.length,
      truncated: walkStats.truncated || results.length >= limit,
      scannedFiles: walkStats.scannedFiles,
      scannedBytes: walkStats.scannedBytes,
    };
  }

  /**
   * find_symbol — locate symbol definitions (heuristic).
   *
   * @param {object} input
   * @param {string} input.name         — symbol name
   * @param {string} [input.kind]       — 'function' | 'class' | 'variable' | 'method' | 'all'
   * @param {string} [input.path]       — search scope
   * @param {number} [input.maxResults]
   * @returns {object}
   */
  findSymbol(input, budget) {
    const { name, kind = 'all', path: searchPath, maxResults = MAX_SEARCH_RESULTS } = input;
    if (!name) throw new Error('find_symbol 缺少 name 参数');

    const results = [];
    const limit = Math.min(maxResults, MAX_SEARCH_RESULTS);
    const nameLower = name.toLowerCase();
    const root = this.service.sandbox.resolve(searchPath || '.');

    const walkStats = walkWorkspace(this.service, root, budget, (fullPath, relPath, stat) => {
      if (results.length >= limit) return false;
      if (stat.size > 200 * 1024) return true;

      let content;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        return true;
      }

      const symbols = extractSymbols(content, relPath);
      for (const sym of symbols) {
        if (sym.name.toLowerCase() !== nameLower) continue;
        if (kind !== 'all' && sym.kind !== kind) continue;
        results.push(sym);
        if (results.length >= limit) return false;
      }
      return true;
    });

    // Sort by confidence desc, then path
    results.sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path));

    return {
      name,
      kind,
      results,
      count: results.length,
      truncated: walkStats.truncated || results.length >= limit,
      scannedFiles: walkStats.scannedFiles,
      scannedBytes: walkStats.scannedBytes,
      confidence: results.length > 0 ? results[0].confidence : 0,
    };
  }

  /**
   * find_refs — find reference candidates for a symbol (heuristic).
   *
   * @param {object} input
   * @param {string} input.name              — symbol name
   * @param {string} input.definitionPath    — file where defined (to exclude)
   * @param {string} [input.path]            — search scope
   * @param {number} [input.maxResults]
   * @returns {object}
   */
  findRefs(input, budget) {
    const { name, definitionPath, path: searchPath, maxResults = MAX_SEARCH_RESULTS } = input;
    if (!name) throw new Error('find_refs 缺少 name 参数');
    if (!definitionPath) throw new Error('find_refs 缺少 definitionPath 参数');

    const results = [];
    const limit = Math.min(maxResults, MAX_SEARCH_RESULTS);
    // Escape for literal match (not regex)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(`\\b${escaped}\\b`, 'gi');
    const root = this.service.sandbox.resolve(searchPath || '.');

    const walkStats = walkWorkspace(this.service, root, budget, (fullPath, relPath, stat) => {
      if (results.length >= limit) return false;
      if (stat.size > 200 * 1024) return true;
      // Skip the definition file itself
      if (relPath === definitionPath) return true;

      let content;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        return true;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= limit) return false;
        const line = lines[i];
        nameRe.lastIndex = 0;
        if (nameRe.test(line)) {
          // Skip import lines that import the symbol from its definition file
          // (those are expected, not "references" in the usage sense)
          const trimmed = line.trim();
          if (/^\s*(import|require|from)\s/.test(trimmed)) continue;

          results.push({
            path: relPath,
            line: i + 1,
            content: trimmed.slice(0, 300),
            context: lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join('\n').slice(0, MAX_EXCERPT_CHARS),
            confidence: 0.7,
            referenceCandidate: true,
          });
        }
      }
      return true;
    });

    // Sort by path then line
    results.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

    return {
      name,
      definitionPath,
      results,
      count: results.length,
      truncated: walkStats.truncated || results.length >= limit,
      scannedFiles: walkStats.scannedFiles,
      scannedBytes: walkStats.scannedBytes,
    };
  }

  /**
   * codebase_map — lightweight project overview.
   *
   * @param {object} input
   * @param {number} [input.depth]     — directory tree depth (default 2)
   * @param {boolean} [input.includeConfigs]
   * @param {boolean} [input.includeTests]
   * @returns {object}
   */
  codebaseMap(input = {}, budget) {
    const depth = Math.min(input.depth || 2, 4);
    const includeConfigs = input.includeConfigs !== false;
    const includeTests = input.includeTests !== false;

    // ── Read package.json for manifest data ──
    let pkg = null;
    try {
      const pkgContent = this.service.readFile('package.json');
      if (pkgContent && pkgContent.content) {
        pkg = JSON.parse(pkgContent.content);
      }
    } catch {
      // no package.json
    }

    // ── Build directory structure ──
    const structure = this._buildTree('.', depth);

    // ── Determine importantFiles ──
    const importantFiles = [];
    const seen = new Set();

    // Priority 1: package.json main / scripts
    if (pkg) {
      if (pkg.main) {
        importantFiles.push({
          path: pkg.main,
          reasons: ['package.json main 指向'],
          type: 'entry',
        });
        seen.add(pkg.main);
      }
      for (const [scriptName, scriptCmd] of Object.entries(pkg.scripts || {})) {
        // Extract first .js/.ts file from script command
        const match = scriptCmd.match(/(\S+\.(?:js|ts|mjs|cjs))/);
        if (match && !seen.has(match[1])) {
          importantFiles.push({
            path: match[1],
            reasons: [`package.json scripts.${scriptName}`],
            type: 'entry',
          });
          seen.add(match[1]);
        }
      }
    }

    // Priority 2: entry-point filename patterns
    const entryPatterns = ['index.js', 'main.js', 'app.js', 'server.js', 'cli.js', 'index.ts', 'main.ts'];
    for (const pattern of entryPatterns) {
      if (seen.has(pattern)) continue;
      try {
        this.service.readFile(pattern);
        importantFiles.push({
          path: pattern,
          reasons: ['文件名匹配入口模式'],
          type: 'entry',
        });
        seen.add(pattern);
      } catch {
        // not found
      }
    }

    // Priority 3: files referenced by ≥3 other files (import/require count)
    const importCounts = this._countImports(seen, budget);
    for (const [filePath, count] of Object.entries(importCounts)) {
      if (count >= 3 && !seen.has(filePath) && importantFiles.length < 10) {
        importantFiles.push({
          path: filePath,
          reasons: [`被 ${count} 个文件 import/require 引用`],
          type: 'referenced',
        });
        seen.add(filePath);
      }
    }

    // Priority 4: root config files
    if (includeConfigs) {
      const configFiles = ['package.json', 'tsconfig.json', 'jsconfig.json', '.env.example', 'AGENTS.md', 'ARCHITECTURE.md'];
      for (const cf of configFiles) {
        if (seen.has(cf)) continue;
        try {
          this.service.readFile(cf);
          importantFiles.push({
            path: cf,
            reasons: ['根目录配置/清单文件'],
            type: 'config',
          });
          seen.add(cf);
        } catch {
          // not found
        }
      }
    }

    // ── Configs ──
    const configs = [];
    if (includeConfigs && pkg) {
      configs.push({ path: 'package.json', type: 'manifest' });
    }

    // ── Test dirs ──
    const testDirs = [];
    if (includeTests) {
      try {
        const testDir = this.service.listDirectory('test');
        if (testDir.entries.some(e => e.type === 'directory')) {
          testDirs.push({ path: 'test/', patterns: ['*.test.js', '*.spec.js'] });
        }
      } catch {
        // no test dir
      }
    }

    return {
      structure,
      importantFiles: importantFiles.slice(0, 10),
      configs,
      testDirs,
      dependencies: pkg ? (pkg.dependencies || {}) : {},
      devDependencies: pkg ? (pkg.devDependencies || {}) : {},
    };
  }

  /**
   * Build directory tree up to a given depth.
   */
  _buildTree(relPath, depth) {
    try {
      const result = this.service.listDirectory(relPath);
      const node = {
        path: result.path || relPath,
        type: 'directory',
        fileCount: result.entries.filter(e => e.type === 'file').length,
        dirCount: result.entries.filter(e => e.type === 'directory').length,
        children: [],
      };

      if (depth <= 0) return node;

      for (const entry of result.entries) {
        if (entry.type === 'directory') {
          // Skip common non-source dirs
          if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) continue;
          node.children.push(this._buildTree(entry.path, depth - 1));
        } else {
          node.children.push({
            path: entry.path,
            type: 'file',
            name: entry.name,
          });
        }
      }

      return node;
    } catch {
      return { path: relPath, type: 'directory', fileCount: 0, dirCount: 0, children: [] };
    }
  }

  /**
   * Count import/require references across workspace files.
   * P1-5 fix: only count files that ACTUALLY EXIST on disk.
   * Guessing extensions creates phantom paths (foo.js.ts, foo/index.js, etc.)
   */
  _countImports(excludePaths, budget) {
    const counts = {};
    const root = this.service.sandbox.root;

    const SOURCE_EXTS = ['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx'];
    const INDEX_FILES = ['index.js', 'index.ts', 'index.mjs', 'index.cjs'];

    const resolveImport = (fromDir, ref) => {
      const normalized = path.normalize(path.join(fromDir, ref));
      // 1. Try as-is (e.g. './foo.js' already has extension)
      // P1-3 fix: must check isFile — if it's a directory, fall through
      // to step 3 so that import './foo' → foo/index.js resolves correctly.
      try {
        const abs = this.service.sandbox.resolve(normalized);
        if (fs.existsSync(abs)) {
          const st = fs.statSync(abs);
          if (st.isFile()) {
            return this.service.sandbox.relative(abs);
          }
          // Directory: fall through to step 3 (index.*)
        }
      } catch { /* skip */ }

      // 2. Try adding source extensions
      for (const ext of SOURCE_EXTS) {
        const candidate = normalized + ext;
        try {
          if (fs.existsSync(this.service.sandbox.resolve(candidate))) {
            return this.service.sandbox.relative(this.service.sandbox.resolve(candidate));
          }
        } catch { /* skip */ }
      }

      // 3. Try as directory with index file
      for (const indexFile of INDEX_FILES) {
        const candidate = path.join(normalized, indexFile);
        try {
          if (fs.existsSync(this.service.sandbox.resolve(candidate))) {
            return this.service.sandbox.relative(this.service.sandbox.resolve(candidate));
          }
        } catch { /* skip */ }
      }

      return null;
    };

    walkWorkspace(this.service, root, budget, (fullPath, relPath, stat) => {
      if (stat.size > 200 * 1024) return true;

      let content;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        return true;
      }

      const importRe = /(?:import|require)\s*\(?[^'"]*['"]([^'"]+)['"]/g;
      let m;
      const fromDir = path.dirname(relPath);
      while ((m = importRe.exec(content)) !== null) {
        const ref = m[1];
        if (ref.startsWith('.')) {
          const resolved = resolveImport(fromDir, ref);
          if (resolved) {
            counts[resolved] = (counts[resolved] || 0) + 1;
          }
        }
      }
      return true;
    });

    return counts;
  }
}

// ── Tool Definitions ─────────────────────────────────────

const TOOL_DEFS = {
  search_code: {
    description: '搜索代码：支持按文件名、文本内容、符号(函数/类/变量)定位。比逐文件 read_file 更高效。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索关键词或正则表达式' },
        path: { type: 'string', description: '搜索范围路径，默认 workspace 根目录' },
        matchType: { type: 'string', enum: ['all', 'filename', 'text', 'symbol'], description: '匹配类型，默认 all' },
        maxResults: { type: 'number', description: '最大结果数，默认 50' },
      },
      required: ['pattern'],
    },
  },
  find_symbol: {
    description: '查找函数、类、变量的定义位置。基于轻量 JS/TS 启发式解析，返回定义及置信度。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '符号名（函数名/类名/变量名）' },
        kind: { type: 'string', enum: ['function', 'class', 'variable', 'method', 'all'], description: '符号类型，默认 all' },
        path: { type: 'string', description: '搜索范围路径' },
        maxResults: { type: 'number', description: '最大结果数' },
      },
      required: ['name'],
    },
  },
  find_refs: {
    description: '查找某个符号在定义文件之外的引用候选位置。基于轻量文本匹配，非完整静态分析。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '符号名' },
        definitionPath: { type: 'string', description: '符号定义所在文件路径（用于排除定义自身）' },
        path: { type: 'string', description: '搜索范围路径' },
        maxResults: { type: 'number', description: '最大结果数' },
      },
      required: ['name', 'definitionPath'],
    },
  },
  codebase_map: {
    description: '生成轻量项目地图：目录结构、重要文件(入口/被引用/配置)、依赖、测试目录。不生成全量索引。',
    input_schema: {
      type: 'object',
      properties: {
        depth: { type: 'number', description: '目录树深度，默认 2' },
        includeConfigs: { type: 'boolean', description: '是否包含配置文件，默认 true' },
        includeTests: { type: 'boolean', description: '是否包含测试目录，默认 true' },
      },
    },
  },
};

export { CodeTools, TOOL_DEFS };