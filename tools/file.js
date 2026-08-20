/**
 * tools/file.js — 文件操作工具
 *
 * 使用 WorkspaceFileService 统一文件访问。
 * 所有路径经 Sandbox 校验，只能操作 workspace 内文件。
 */

import fs from 'fs';
import path from 'path';
import { WorkspaceFileService } from '../fileservice.js';

class FileTools {
  constructor(workspace) {
    this.service = new WorkspaceFileService(workspace);
  }

  async listDirectory(input) {
    return this.service.listDirectory(input.path || '.');
  }

  async readFile(input) {
    return this.service.readFile(input.path, {
      startLine: input.startLine,
      endLine: input.endLine,
      offset: input.offset,
      limit: input.limit,
    });
  }

  async writeFile(input) {
    const { path: filePath, content } = input;
    if (!filePath) throw new Error('write_file 缺少 path 参数');
    if (content === undefined || content === null) throw new Error('write_file 缺少 content 参数');

    if (this.service.isSensitive(filePath)) {
      throw new Error(`拒绝写入敏感文件: ${filePath}。Agent 不应修改 .env、密钥等敏感文件。`);
    }

    const absolute = this.service.sandbox.resolve(filePath);
    const dir = path.dirname(absolute);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let oldContent = null, existed = false;
    if (fs.existsSync(absolute)) {
      existed = true;
      try { oldContent = fs.readFileSync(absolute, 'utf-8'); } catch {}
    }

    fs.writeFileSync(absolute, content, 'utf-8');

    return {
      path: this.service.sandbox.relative(absolute),
      action: existed ? 'modified' : 'created',
      size: Buffer.byteLength(content, 'utf-8'),
    };
  }

  async editFile(input) {
    const { path: filePath, oldString, newString } = input;
    if (!filePath) throw new Error('edit_file 缺少 path 参数');
    if (oldString === undefined || newString === undefined) throw new Error('edit_file 缺少 oldString / newString 参数');

    if (this.service.isSensitive(filePath)) throw new Error(`拒绝修改敏感文件: ${filePath}。`);

    const absolute = this.service.sandbox.resolve(filePath);
    if (!fs.existsSync(absolute)) throw new Error(`文件不存在: ${filePath}`);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error(`不是文件: ${filePath}`);

    const content = fs.readFileSync(absolute, 'utf-8');
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) throw new Error(`oldString 未在文件中找到: ${filePath}`);
    if (occurrences > 1) throw new Error(`oldString 出现 ${occurrences} 次，不唯一。请提供更多上下文。`);

    const newContent = content.replace(oldString, newString);
    fs.writeFileSync(absolute, newContent, 'utf-8');

    return {
      path: this.service.sandbox.relative(absolute),
      action: 'modified',
      replaced: true,
      occurrences,
    };
  }

  async searchFiles(input) {
    const { pattern, path: searchPath, maxResults = 50 } = input;
    if (!pattern) throw new Error('search_files 缺少 pattern 参数');

    let regex;
    try { regex = new RegExp(pattern); } catch (err) {
      throw new Error(`非法正则表达式: ${pattern}。错误: ${err.message}`);
    }

    const results = [];
    const root = this.service.sandbox.resolve(searchPath || '.');
    const MAX_RESULTS = Math.min(maxResults, 200);
    const MAX_LINE_LENGTH = 300;

    this._walk(root, (filePath) => {
      if (results.length >= MAX_RESULTS) return false;
      if (this.service.isBinary(filePath)) return true;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 1024 * 1024) return true;
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({
              path: this.service.sandbox.relative(filePath),
              line: i + 1,
              content: lines[i].trim().slice(0, MAX_LINE_LENGTH),
            });
            if (results.length >= MAX_RESULTS) return false;
          }
        }
      } catch {}
      return true;
    });

    return { pattern, results, count: results.length, truncated: results.length >= MAX_RESULTS };
  }

  async deleteFile(input) {
    const { path: filePath } = input;
    if (!filePath) throw new Error('delete_file 缺少 path 参数');

    if (this.service.isSensitive(filePath)) throw new Error(`拒绝删除敏感文件: ${filePath}。`);

    const absolute = this.service.sandbox.resolve(filePath);
    if (!fs.existsSync(absolute)) throw new Error(`文件不存在: ${filePath}`);
    const stat = fs.statSync(absolute);

    fs.rmSync(absolute, { recursive: stat.isDirectory() });

    return {
      path: this.service.sandbox.relative(absolute),
      action: 'deleted',
      wasDirectory: stat.isDirectory(),
    };
  }

  _walk(dir, cb) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (cb(full) !== false) this._walk(full, cb);
      } else if (entry.isFile()) {
        cb(full);
      }
    }
  }
}

const TOOL_DEFS = {
  list_directory: {
    description: '列出 workspace 中某个目录的内容，返回树状结构。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径，默认根目录' } },
      required: [],
    },
  },
  read_file: {
    description: '读取文件内容。支持 startLine/endLine 范围读取，大文件可分段读取。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['path'],
    },
  },
  write_file: {
    description: '创建或覆盖文件。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  edit_file: {
    description: '精确修改文件中的一段内容。oldString 必须唯一。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } },
      required: ['path', 'oldString', 'newString'],
    },
  },
  search_files: {
    description: '搜索文件内容，支持正则。',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'number' } },
      required: ['pattern'],
    },
  },
  delete_file: {
    description: '删除文件或目录。危险操作，需要用户确认。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    dangerous: true,
  },
};

export { FileTools, TOOL_DEFS };