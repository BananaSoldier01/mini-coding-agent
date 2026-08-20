/**
 * tools/file.js — 文件操作工具
 *
 * 提供 list_directory / read_file / write_file / edit_file / search_files / delete_file
 * 所有路径经 Sandbox 校验，只能操作 workspace 内文件。
 */

import fs from 'fs';
import path from 'path';
import { Sandbox } from '../sandbox.js';

/** 忽略的目录/文件（类似 .gitignore 简化版） */
const IGNORE = new Set([
  'node_modules', '.git', '.DS_Store', '__pycache__', '.venv',
  'dist', 'build', '.next', '.nuxt', 'coverage',
]);

function shouldIgnore(name) {
  return IGNORE.has(name) || name.startsWith('.');
}

/**
 * list_directory — 列出目录内容（树状，仅一层）
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
    .filter((e) => !shouldIgnore(e.name))
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      path: sandbox.relative(path.join(dirPath, e.name)),
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
 * read_file — 读取文件内容
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
  if (stat.size > 200 * 1024) {
    throw new Error(`文件过大 (${stat.size} bytes)，请用 search_files 搜索内容`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return {
    path: sandbox.relative(filePath),
    size: stat.size,
    content,
    lines: content.split('\n').length,
  };
}

/**
 * write_file — 创建或覆盖文件（自动创建父目录）
 */
async function writeFile(input, ctx) {
  const { sandbox, tracker } = ctx;
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
    });
  }

  const result = {
    path: sandbox.relative(absolute),
    action: existed ? 'modified' : 'created',
    size: Buffer.byteLength(content, 'utf-8'),
  };

  // 如果是覆盖已有文件，生成 diff 供前端展示
  if (existed && oldContent !== null) {
    result.diff = makeDiff(oldContent, content);
  }

  return result;
}

/**
 * edit_file — 搜索替换编辑（精确匹配 oldString，必须唯一）
 */
async function editFile(input, ctx) {
  const { sandbox, tracker } = ctx;
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
    });
  }

  return {
    path: sandbox.relative(absolute),
    action: 'modified',
    replaced: true,
    occurrences,
    diff: makeDiff(content, newContent),
  };
}

/**
 * search_files — 在 workspace 内搜索文本（类似 grep）
 */
async function searchFiles(input, ctx) {
  const { sandbox } = ctx;
  const { pattern, path: searchPath, maxResults = 50 } = input;
  if (!pattern) throw new Error('search_files 缺少 pattern 参数');

  const regex = new RegExp(pattern, 'g');
  const results = [];
  const root = sandbox.resolve(searchPath || '.');
  walk(root, sandbox, (filePath) => {
    if (results.length >= maxResults) return false;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 500 * 1024) return true; // skip big files
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          regex.lastIndex = 0;
          results.push({
            path: sandbox.relative(filePath),
            line: i + 1,
            content: lines[i].trim().slice(0, 200),
          });
          if (results.length >= maxResults) return false;
        }
      }
    } catch {
      // ignore unreadable files
    }
    return true;
  });

  return { pattern, results, count: results.length };
}

/**
 * delete_file — 删除文件（危险操作，需确认）
 */
async function deleteFile(input, ctx) {
  const { sandbox, tracker } = ctx;
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
    if (shouldIgnore(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (cb(full) !== false) walk(full, sandbox, cb);
    } else if (entry.isFile()) {
      cb(full);
    }
  }
}

/** 生成简单 diff */
function makeDiff(old, newStr) {
  const oldLines = old.split('\n');
  const newLines = newStr.split('\n');
  const diff = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (oldLines[i] !== undefined) diff.push({ type: 'remove', line: i + 1, content: oldLines[i] });
      if (newLines[i] !== undefined) diff.push({ type: 'add', line: i + 1, content: newLines[i] });
    }
  }
  return diff;
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
    description: '读取 workspace 中某个文件的完整内容。大文件（>200KB）会被拒绝，建议用 search_files 搜索。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于 workspace 根目录' },
      },
      required: ['path'],
    },
    execute: readFile,
  },
  write_file: {
    description: '创建新文件或覆盖已有文件。自动创建父目录。这是非破坏性操作，覆盖前会记录原内容。',
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
    description: '修改文件中的一段内容。oldString 必须精确且唯一地出现在文件中，然后被替换为 newString。比 write_file 更安全，只改指定部分。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于 workspace 根目录' },
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