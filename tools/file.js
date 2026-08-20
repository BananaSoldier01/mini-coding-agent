/**
 * tools/file.js — 文件操作工具
 *
 * 提供 list_directory / read_file / write_file / edit_file / search_files / delete_file
 * 所有路径经 Sandbox 校验，只能操作 workspace 内文件。
 *
 * 隐藏文件策略：
 *   - 工程忽略：node_modules / .git / dist / build 等（永远不列出）
 *   - Dotfile：正常显示（.gitignore / .eslintrc 等工程文件很重要）
 *   - Secret 防护：.env / 私钥等由 policy.js 拒绝读写
 */

import fs from 'fs';
import path from 'path';
import { unifiedDiff } from '../tracker.js';

// ── 始终忽略的目录/文件（工程构建产物）────────────────
const ALWAYS_IGNORE = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', '.nuxt', 'coverage', '.nyc_output',
  '.cache', '.turbo', '.output', '.pytest_cache', '.idea', '.vscode',
]);

// ── 始终忽略的文件扩展名（二进制/大文件）──────────────
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj',
  '.wasm', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.ogg',
  '.lock',
]);

function shouldAlwaysIgnore(name) {
  return ALWAYS_IGNORE.has(name);
}

function isBinaryFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isHidden(name) {
  return name.startsWith('.');
}

/**
 * list_directory — 列出目录内容
 */
async function listDirectory(input, ctx) {
  const { sandbox } = ctx;
  const dirPath = sandbox.resolve(input.path || '.');
  if (!fs.existsSync(dirPath)) {
    throw new Error(`目录不存在: ${input.path || '.'}`);
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`不是目录: ${input.path}`);
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((e) => !shouldAlwaysIgnore(e.name))
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      path: sandbox.relative(path.join(dirPath, e.name)),
      hidden: isHidden(e.name),
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return {
    path: sandbox.relative(dirPath),
    entries,
    count: entries.length,
  };
}

/**
 * read_file — 读取文件内容（支持范围读取）
 *
 * @param {object} input - { path, startLine?, endLine?, offset?, limit? }
 *   - startLine/endLine: 按行范围读取（1-based）
 *   - offset/limit: 按字符偏移读取
 *   两者互斥，优先 startLine/endLine
 */
async function readFile(input, ctx) {
  const { sandbox } = ctx;
  const filePath = sandbox.resolve(input.path);
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${input.path}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`不是文件: ${input.path}`);
  }

  // 拒绝读取二进制文件
  if (isBinaryFile(filePath)) {
    throw new Error(`二进制文件不支持读取: ${input.path}`);
  }

  const MAX_FILE_SIZE = 500 * 1024; // 500KB
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(
      `文件过大 (${stat.size} bytes)。请使用 startLine/endLine 分段读取，或用 search_files 搜索。`
    );
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n');
  const totalLines = allLines.length;

  // 范围读取
  let readLines = allLines;
  let startLine = 1;
  let endLine = totalLines;

  if (input.startLine || input.endLine) {
    startLine = Math.max(1, parseInt(input.startLine, 10) || 1);
    endLine = input.endLine ? Math.min(totalLines, parseInt(input.endLine, 10)) : totalLines;
    if (startLine > endLine) {
      throw new Error(`startLine (${startLine}) > endLine (${endLine})`);
    }
    readLines = allLines.slice(startLine - 1, endLine);
  } else if (input.offset !== undefined || input.limit !== undefined) {
    const offset = Math.max(0, parseInt(input.offset, 10) || 0);
    const limit = Math.min(200, parseInt(input.limit, 10) || 200);
    readLines = allLines.slice(offset, offset + limit);
    startLine = offset + 1;
    endLine = Math.min(totalLines, offset + limit);
  }

  const result = {
    path: sandbox.relative(filePath),
    size: stat.size,
    totalLines,
    startLine,
    endLine,
    content: readLines.join('\n'),
    lines: readLines.length,
    hasMore: endLine < totalLines,
  };

  if (endLine < totalLines) {
    result.nextHint = `还有 ${totalLines - endLine} 行，可用 startLine: ${endLine + 1} 继续读取`;
  }

  return result;
}

/**
 * write_file — 创建或覆盖文件
 */
async function writeFile(input, ctx) {
  const { sandbox, tracker, run } = ctx;
  const { path: filePath, content } = input;
  if (!filePath) throw new Error('write_file 缺少 path 参数');
  if (content === undefined || content === null) throw new Error('write_file 缺少 content 参数');

  const absolute = sandbox.resolve(filePath);
  const dir = path.dirname(absolute);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let oldContent = null;
  let existed = false;
  if (fs.existsSync(absolute)) {
    existed = true;
    try {
      oldContent = fs.readFileSync(absolute, 'utf-8');
    } catch {}
  }

  fs.writeFileSync(absolute, content, 'utf-8');

  // 记录变更
  if (tracker) {
    tracker.record({
      type: existed ? 'modify' : 'create',
      path: sandbox.relative(absolute),
      oldContent,
      newContent: content,
      taskId: run?.sessionId || null,
      runId: run?.sessionId || null,
    });
  }

  const result = {
    path: sandbox.relative(absolute),
    action: existed ? 'modified' : 'created',
    size: Buffer.byteLength(content, 'utf-8'),
  };

  // 如果是覆盖已有文件，生成真实 diff
  if (existed && oldContent !== null) {
    result.diff = unifiedDiff(oldContent, content);
  }

  return result;
}

/**
 * edit_file — 搜索替换编辑
 */
async function editFile(input, ctx) {
  const { sandbox, tracker, run } = ctx;
  const { path: filePath, oldString, newString } = input;
  if (!filePath) throw new Error('edit_file 缺少 path 参数');
  if (oldString === undefined || newString === undefined) {
    throw new Error('edit_file 缺少 oldString / newString 参数');
  }

  const absolute = sandbox.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    throw new Error(`不是文件: ${filePath}`);
  }

  const content = fs.readFileSync(absolute, 'utf-8');
  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    throw new Error(`oldString 未在文件中找到: ${filePath}`);
  }
  if (occurrences > 1) {
    throw new Error(`oldString 在文件中出现 ${occurrences} 次，不唯一。请提供更多上下文使其唯一。`);
  }

  const newContent = content.replace(oldString, newString);
  fs.writeFileSync(absolute, newContent, 'utf-8');

  if (tracker) {
    tracker.record({
      type: 'modify',
      path: sandbox.relative(absolute),
      oldContent: content,
      newContent,
      taskId: run?.sessionId || null,
      runId: run?.sessionId || null,
    });
  }

  return {
    path: sandbox.relative(absolute),
    action: 'modified',
    replaced: true,
    occurrences,
    diff: unifiedDiff(content, newContent),
  };
}

/**
 * search_files — 在 workspace 内搜索文本
 */
async function searchFiles(input, ctx) {
  const { sandbox } = ctx;
  const { pattern, path: searchPath, maxResults = 50 } = input;
  if (!pattern) throw new Error('search_files 缺少 pattern 参数');

  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    throw new Error(`非法正则表达式: ${pattern}。错误: ${err.message}`);
  }

  const results = [];
  const root = sandbox.resolve(searchPath || '.');
  const MAX_RESULTS = Math.min(maxResults, 200);
  const MAX_LINE_LENGTH = 300;

  walk(root, sandbox, (filePath) => {
    if (results.length >= MAX_RESULTS) return false;
    // 跳过二进制文件
    if (isBinaryFile(filePath)) return true;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 1024 * 1024) return true; // skip > 1MB
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({
            path: sandbox.relative(filePath),
            line: i + 1,
            content: lines[i].trim().slice(0, MAX_LINE_LENGTH),
          });
          if (results.length >= MAX_RESULTS) return false;
        }
      }
    } catch {
      // ignore unreadable files
    }
    return true;
  });

  return { pattern, results, count: results.length, truncated: results.length >= MAX_RESULTS };
}

/**
 * delete_file — 删除文件（危险操作，需确认）
 */
async function deleteFile(input, ctx) {
  const { sandbox, tracker, run } = ctx;
  const { path: filePath } = input;
  if (!filePath) throw new Error('delete_file 缺少 path 参数');

  const absolute = sandbox.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const stat = fs.statSync(absolute);
  let oldContent = null;
  if (stat.isFile()) {
    oldContent = fs.readFileSync(absolute, 'utf-8');
  }

  fs.rmSync(absolute, { recursive: stat.isDirectory() });

  if (tracker) {
    tracker.record({
      type: 'delete',
      path: sandbox.relative(absolute),
      oldContent,
      newContent: null,
      taskId: run?.sessionId || null,
      runId: run?.sessionId || null,
    });
  }

  return { path: sandbox.relative(absolute), action: 'deleted', wasDirectory: stat.isDirectory() };
}

/** 遍历目录 */
function walk(dir, sandbox, cb) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (shouldAlwaysIgnore(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (cb(full) !== false) walk(full, sandbox, cb);
    } else if (entry.isFile()) {
      cb(full);
    }
  }
}

const fileTools = {
  list_directory: {
    description: '列出 workspace 中某个目录的内容（文件与子目录），返回树状结构。路径相对于 workspace 根目录。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，相对于 workspace 根目录，默认为根目录' },
      },
      required: [],
    },
    execute: listDirectory,
  },
  read_file: {
    description:
      '读取 workspace 中某个文件的内容。支持范围读取：startLine/endLine 按行读取，offset/limit 按偏移读取。' +
      '大文件（>500KB）会拒绝，建议分段读取或用 search_files 搜索。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于 workspace 根目录' },
        startLine: { type: 'number', description: '起始行号（1-based），与 endLine 配合使用' },
        endLine: { type: 'number', description: '结束行号（1-based），与 startLine 配合使用' },
        offset: { type: 'number', description: '字符偏移（与 limit 配合）' },
        limit: { type: 'number', description: '读取行数，默认 200' },
      },
      required: ['path'],
    },
    execute: readFile,
  },
  write_file: {
    description: '创建新文件或覆盖已有文件。自动创建父目录。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于 workspace 根目录' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
    execute: writeFile,
  },
  edit_file: {
    description: '修改文件中的一段内容。oldString 必须精确且唯一地出现在文件中。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        oldString: { type: 'string', description: '要替换的原文本，必须精确且唯一' },
        newString: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    execute: editFile,
  },
  search_files: {
    description: '在 workspace 内搜索文本内容（类似 grep），返回匹配的文件与行号。支持正则表达式。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（正则表达式）' },
        path: { type: 'string', description: '搜索起始目录，默认为根目录' },
        maxResults: { type: 'number', description: '最大结果数，默认 50' },
      },
      required: ['pattern'],
    },
    execute: searchFiles,
  },
  delete_file: {
    description: '删除文件或目录。这是危险操作，需要用户确认后才能执行。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录路径' },
      },
      required: ['path'],
    },
    execute: deleteFile,
    dangerous: true,
  },
};

export { fileTools };