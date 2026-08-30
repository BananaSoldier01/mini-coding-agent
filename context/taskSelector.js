/**
 * context/taskSelector.js — V1.5.0 Task-aware Context Selection
 *
 * Lightweight preflight: before the Agent loop starts, inspect the task,
 * decide whether codebase understanding is needed, and if so, search for
 * the most relevant files to inject as supplementalContext.
 *
 * Design constraints:
 *   - supplementalContext is consumed by ContextBuilder (budget + injection)
 *   - Triggered only by task type, NOT by session turn count
 *   - Hard limits prevent runaway scanning
 *   - No glob dependency; no full-repo indexing
 */

import { CodeTools } from '../tools/code.js';

// ── Hard Limits ──────────────────────────────────────────
const LIMITS = {
  maxSelectedFiles: 6,
  maxInjectedChars: 12_000,
  maxSearchResults: 50,
  maxScannedFiles: 300,
  maxScannedBytes: 5 * 1024 * 1024, // 5 MB
};

// ── Task Classification ──────────────────────────────────

/**
 * Decide whether this task needs codebase preflight.
 *
 * Trigger (any one):
 *   - Bug / fix / modify language + module reference
 *   - Contains a plausible identifier (function/class/variable name)
 *   - "find" / "locate" / "search" / "understand" + module name
 *   - Cross-module feature work implied by task text
 *
 * Skip:
 *   - Create new file / write new file
 *   - Run command / execute / test
 *   - Simple single-file edit with no module references
 */
function shouldPreflight(task) {
  if (!task || typeof task !== 'string') return false;
  const t = task.toLowerCase();

  // ── Skip signals (check first — these are unambiguous) ──
  const skipPatterns = [
    // Create new
    /^\s*(create|make|generate|write|new)\s+(a\s+)?(file|component|module)/,
    /创建|新建|创建文件|生成文件/,
    // Run / execute
    /run\s+(the\s+)?(tests?|command|script)/,
    /execute\s+(the\s+)?(command|script)/,
    /跑|运行|执行/,
    // Simple: "change X to Y" with no module context
    /^change\s+\S+\s+to\s+\S+$/,
  ];
  for (const pat of skipPatterns) {
    if (pat.test(t)) return false;
  }

  // ── Trigger signals ──
  // Note: \b doesn't work with underscores (they are word chars).
  // Also check with _ replaced by space for snake_case task names.
  const tSpace = t.replace(/_/g, ' ');
  const triggerPatterns = [
    // Bug / fix
    /\b(bug|fix|broken|error|issue|crash|fail|regression)\b/,
    // snake_case variant: _bug_ or _fix_ etc.
    /(?:^|[\s_])(bug|fix|broken|error|issue|crash|fail|regression)(?:[\s_]|$)/,
    /修复|修复bug|解决.*问题|调试|排查/,
    // Modify / change existing code
    /\b(modify|change|update|refactor|rewrite|edit)\b.*\b(file|module|function|class|component|service|handler|controller|route|endpoint)\b/,
    /修改|改动|重构|重写/,
    // Find / locate / understand
    /\b(find|locate|search|look\s+for|understand|explore|investigate)\b/,
    /找|搜索|查找|定位|理解|探索|调研|分析/,
    // Cross-module implied
    /\b(integrate|connect|bridge|wire\s+up|plumb)\b/,
    /集成|连接|打通/,
  ];
  for (const pat of triggerPatterns) {
    if (pat.test(t) || pat.test(tSpace)) return true;
  }

  // ── Identifier heuristic: if task contains a plausible code identifier ──
  // (camelCase or snake_case word that's ≥4 chars and not a common English word)
  // Must check ORIGINAL case for camelCase detection — lowercasing destroys [A-Z].
  // Use regex directly on task (not word-split, which breaks on _ and -).
  const commonWords = new Set([
    'this', 'that', 'with', 'from', 'have', 'were', 'they', 'their', 'what', 'when',
    'which', 'will', 'would', 'could', 'should', 'about', 'every', 'first', 'after',
    'where', 'there', 'them', 'then', 'than', 'also', 'only', 'other', 'some', 'time',
    'file', 'code', 'test', 'user', 'data', 'system', 'task', 'plan', 'run', 'agent',
  ]);
  const idRe = /[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+|[A-Za-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Za-z][a-z0-9]*(?:-[a-z0-9]+)+/g;
  let idMatch;
  while ((idMatch = idRe.exec(task)) !== null) {
    const w = idMatch[0];
    if (w.length < 4) continue;
    if (commonWords.has(w.toLowerCase())) continue;
    return true;
  }

  return false;
}

/**
 * Extract candidate search terms from task text.
 */
function extractSearchTerms(task) {
  const terms = new Set();

  // Extract quoted strings
  const quoted = task.match(/["']([^"']+)["']/g);
  if (quoted) {
    for (const q of quoted) {
      const cleaned = q.slice(1, -1).toLowerCase();
      if (cleaned.length >= 2) terms.add(cleaned);
    }
  }

  // Extract camelCase / snake_case / kebab-case identifiers.
  // Must run on ORIGINAL case so camelCase patterns match (lowercasing
  // would destroy the [A-Z] that camelCase detection needs).
  const identifierRe = /[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+|[A-Za-z][a-z0-9]*(?:-[a-z0-9]+)+/g;
  let m;
  while ((m = identifierRe.exec(task)) !== null) {
    const w = m[0].toLowerCase();
    if (w.length >= 4) terms.add(w);
  }

  return Array.from(terms).slice(0, 10);
}

/**
 * Run lightweight preflight context selection.
 *
 * @param {object} opts
 * @param {string} opts.task       — the task description
 * @param {string} opts.workspace  — workspace root path
 * @param {object} [opts.existing] — existing CodeTools instance (for testing)
 * @returns {object|null} supplementalContext or null if not triggered
 */
async function preflightContext(opts) {
  const { task, workspace, existing } = opts;

  if (!shouldPreflight(task)) return null;

  const code = existing || new CodeTools(workspace);
  const searchLog = [];
  const candidates = []; // { path, score, reason, excerpt? }
  const seen = new Set();
  let scannedFiles = 0;
  let scannedBytes = 0;
  let truncated = false;

  // ── Step 1: Extract search terms ──
  const terms = extractSearchTerms(task);
  searchLog.push({ type: 'term_extraction', terms, timestamp: Date.now() });

  // ── Step 2: Search for each term ──
  for (const term of terms) {
    if (truncated) break;

    // search_code with matchType='all'
    try {
      const result = code.searchCode({ pattern: term, matchType: 'all', maxResults: 20 });
      searchLog.push({
        type: 'search_code',
        query: term,
        resultCount: result.count,
        timestamp: Date.now(),
      });

      scannedFiles += 0; // walkWorkspace tracks internally; we approximate here
      if (result.truncated) truncated = true;

      for (const r of result.results) {
        if (candidates.length >= LIMITS.maxSearchResults) break;
        if (seen.has(r.path)) continue;
        seen.add(r.path);

        // Compute relevance score
        let score = r.score || 5;
        let reason = `搜索 "${term}" 命中 (${r.matchType})`;

        // Boost: filename match
        if (r.matchType === 'filename') score += 5;
        // Boost: symbol match
        if (r.matchType === 'symbol') score += 3;
        // Boost: reference match
        if (r.matchType === 'reference') score += 2;

        candidates.push({
          path: r.path,
          score,
          reason,
          matchType: r.matchType,
          line: r.line,
          excerpt: r.content?.slice(0, 200),
        });
      }
    } catch (err) {
      searchLog.push({ type: 'search_error', query: term, error: err.message, timestamp: Date.now() });
    }
  }

  // ── Step 3: Also try codebase_map for structure awareness ──
  let projectMap = null;
  try {
    projectMap = code.codebaseMap({ depth: 2 });
    searchLog.push({
      type: 'codebase_map',
      importantFiles: projectMap.importantFiles.map(f => f.path),
      timestamp: Date.now(),
    });

    // Add importantFiles as candidates with lower score
    for (const imp of projectMap.importantFiles) {
      if (candidates.length >= LIMITS.maxSearchResults) break;
      if (seen.has(imp.path)) continue;
      seen.add(imp.path);
      candidates.push({
        path: imp.path,
        score: 3,
        reason: `项目地图标记: ${imp.reasons.join('; ')}`,
        matchType: 'structure',
      });
    }
  } catch (err) {
    // non-fatal
  }

  // ── Step 4: Sort candidates by score desc, select top-K ──
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates.slice(0, LIMITS.maxSelectedFiles);

  // ── Step 5: Read excerpts for selected files, build contextBlock ──
  const selectedFiles = [];
  let contextBlock = '';
  let injectedChars = 0;

  for (const cand of selected) {
    if (injectedChars >= LIMITS.maxInjectedChars) break;

    try {
      // Read first 40 lines as excerpt
      const fileData = code.service.readFile(cand.path, { limit: 40 });
      const excerpt = fileData?.content || cand.excerpt || '';
      const excerptChars = Math.min(excerpt.length, 600);

      selectedFiles.push({
        path: cand.path,
        reason: cand.reason,
        relevance: cand.score,
        excerpt: excerpt.slice(0, excerptChars),
        matchType: cand.matchType,
      });

      const block = `\n── ${cand.path} ──\n${excerpt.slice(0, excerptChars)}\n`;
      if (injectedChars + block.length <= LIMITS.maxInjectedChars) {
        contextBlock += block;
        injectedChars += block.length;
      }
    } catch {
      // file may have been deleted; skip
    }
  }

  // ── Step 6: Build result ──
  const result = {
    triggered: true,
    task: task.slice(0, 200),
    searchLog,
    candidates: candidates.slice(0, 20), // keep top 20 for transparency
    selectedFiles,
    contextBlock: contextBlock.slice(0, LIMITS.maxInjectedChars),
    injectedChars: contextBlock.length,
    metrics: {
      selectedFiles: selectedFiles.length,
      injectedChars: contextBlock.length,
      candidatesConsidered: candidates.length,
      searchTerms: terms.length,
      truncated,
    },
    timestamp: Date.now(),
  };

  return result;
}

export {
  shouldPreflight,
  extractSearchTerms,
  preflightContext,
  LIMITS,
};