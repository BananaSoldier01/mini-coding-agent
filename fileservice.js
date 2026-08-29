/**
 * WorkspaceFileService — 统一 Workspace 文件访问层
 *
 * 由 Agent Tool、Web File Viewer、Server API 共同复用。
 * 保证 workspace boundary / symlink policy / sensitive file policy / binary detection / max-size 一致。
 */

import fs from 'fs';
import path from 'path';
import { Sandbox } from './sandbox.js';
import { isSensitiveFilePath } from './policy.js';

// ── 常量 ──────────────────────────────────────────────
const MAX_FILE_SIZE = 500 * 1024;        // 500KB 单文件最大
const MAX_RANGE_LINES = 200;            // 单次 range read 最大行数
const BINARY_CHECK_BYTES = 8192;         // 前 8KB 检测二进制

// ── 二进制检测 ────────────────────────────────────────
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj',
  '.wasm', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.ogg',
  '.lock', '.class', '.jar', '.war',
]);

function isBinaryExtension(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isBinaryContent(buffer) {
  // 检查前 N 字节是否包含 null byte
  const check = buffer.slice(0, BINARY_CHECK_BYTES);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

class WorkspaceFileService {
  constructor(root) {
    this.sandbox = new Sandbox(root);
    this.root = this.sandbox.root;
  }

  // ── 列目录 ──────────────────────────────────────────
  listDirectory(relPath = '.') {
    const dirPath = this.sandbox.resolve(relPath);
    if (!fs.existsSync(dirPath)) {
      throw new Error(`目录不存在: ${relPath}`);
    }
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      throw new Error(`不是目录: ${relPath}`);
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.name !== 'node_modules' && e.name !== '.git' && e.name !== '__pycache__')
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: this.sandbox.relative(path.join(dirPath, e.name)),
        hidden: e.name.startsWith('.'),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return {
      path: this.sandbox.relative(dirPath),
      entries,
      count: entries.length,
    };
  }

  // ── 构建文件树 ──────────────────────────────────────
  buildTree(relPath = '.', maxDepth = 4) {
    const absolute = this.sandbox.resolve(relPath);
    if (!fs.existsSync(absolute)) return null;
    const stat = fs.statSync(absolute);

    if (stat.isFile()) {
      return { name: path.basename(absolute), type: 'file', path: relPath };
    }

    const node = {
      name: relPath === '.' ? 'workspace' : path.basename(absolute),
      type: 'directory',
      path: relPath,
      children: [],
    };

    if (maxDepth <= 0) {
      node.expanded = false;
      return node;
    }

    const entries = fs.readdirSync(absolute, { withFileTypes: true })
      .filter((e) => e.name !== 'node_modules' && e.name !== '.git' && e.name !== '__pycache__')
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of entries) {
      const childPath = path.join(relPath, entry.name);
      const child = this.buildTree(childPath, maxDepth - 1);
      if (child) node.children.push(child);
    }

    return node;
  }

  // ── 读取文件（支持范围读取 + 流式）───────────────────
  readFile(relPath, opts = {}) {
    const { startLine, endLine, offset, limit } = opts;
    const absolute = this.sandbox.resolve(relPath);

    // 敏感文件检查（先于存在性检查，确保敏感文件即使不存在也不被访问）
    if (isSensitiveFilePath(relPath)) {
      throw new Error(`拒绝读取敏感文件: ${relPath}。Agent 不应访问 .env、密钥等敏感文件。`);
    }

    if (!fs.existsSync(absolute)) {
      throw new Error(`文件不存在: ${relPath}`);
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      throw new Error(`不是文件: ${relPath}`);
    }

    // 二进制文件检查 — 使用统一 Binary Detection（唯一事实源）
    if (this.isBinary(relPath)) {
      throw new Error(`二进制文件不支持读取: ${relPath}`);
    }

    // 大小检查
    if (stat.size > MAX_FILE_SIZE) {
      if (startLine || endLine || offset !== undefined) {
        return this._readRange(absolute, relPath, stat.size, opts);
      }
      throw new Error(
        `文件过大 (${stat.size} bytes)。请使用 startLine/endLine 分段读取。`
      );
    }

    // 小文件直接读取
    const content = fs.readFileSync(absolute, 'utf-8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    let readLines = allLines;
    let sLine = 1;
    let eLine = totalLines;

    if (startLine || endLine) {
      sLine = Math.max(1, parseInt(startLine, 10) || 1);
      eLine = endLine ? Math.min(totalLines, parseInt(endLine, 10)) : totalLines;
      if (sLine > eLine) throw new Error(`startLine (${sLine}) > endLine (${eLine})`);
      readLines = allLines.slice(sLine - 1, eLine);
    } else if (offset !== undefined) {
      const off = Math.max(0, parseInt(offset, 10) || 0);
      const lim = Math.min(MAX_RANGE_LINES, parseInt(limit, 10) || MAX_RANGE_LINES);
      readLines = allLines.slice(off, off + lim);
      sLine = off + 1;
      eLine = Math.min(totalLines, off + lim);
    }

    return {
      path: relPath,
      size: stat.size,
      totalLines,
      startLine: sLine,
      endLine: eLine,
      content: readLines.join('\n'),
      lines: readLines.length,
      hasMore: eLine < totalLines,
      nextHint: eLine < totalLines ? `还有 ${totalLines - eLine} 行，startLine: ${eLine + 1}` : undefined,
    };
  }

  // ── 大文件范围读取（流式，不载入整个文件）─────────────
  _readRange(absolute, relPath, fileSize, opts) {
    const { startLine, endLine, offset, limit } = opts;

    // 确定起始行和结束行
    let startLineNum, endLineNum;

    if (startLine !== undefined) {
      startLineNum = Math.max(1, parseInt(startLine, 10) || 1);
      endLineNum = endLine ? parseInt(endLine, 10) : startLineNum + MAX_RANGE_LINES - 1;
    } else if (offset !== undefined) {
      startLineNum = Math.max(0, parseInt(offset, 10) || 0) + 1;
      const lim = Math.min(MAX_RANGE_LINES, parseInt(limit, 10) || MAX_RANGE_LINES);
      endLineNum = startLineNum + lim - 1;
    } else {
      startLineNum = 1;
      endLineNum = MAX_RANGE_LINES;
    }

    // 流式读取，只读取需要的行
    const fd = fs.openSync(absolute, 'r');
    try {
      const lines = [];
      let lineNum = 0;
      let buffer = '';
      let pos = 0;
      const bufSize = 64 * 1024; // 64KB chunks

      // 如果 startLine 很大，先快速跳过
      if (startLineNum > 1) {
        // 读取 chunk 跳过行
        const skipBuf = Buffer.alloc(bufSize);
        while (pos < fileSize && lineNum < startLineNum - 1) {
          const bytesRead = fs.readSync(fd, skipBuf, 0, bufSize, pos);
          if (bytesRead === 0) break;
          pos += bytesRead;
          const text = skipBuf.toString('utf-8', 0, bytesRead);
          buffer += text;
          let nlIdx;
          while ((nlIdx = buffer.indexOf('\n')) !== -1) {
            lineNum++;
            buffer = buffer.slice(nlIdx + 1);
            if (lineNum >= startLineNum - 1) break;
          }
        }
      }

      // 读取目标行
      const readBuf = Buffer.alloc(bufSize);
      while (pos < fileSize && lineNum < endLineNum) {
        const bytesRead = fs.readSync(fd, readBuf, 0, bufSize, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const text = readBuf.toString('utf-8', 0, bytesRead);
        buffer += text;
        let nlIdx;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          lineNum++;
          if (lineNum >= startLineNum && lineNum <= endLineNum) {
            lines.push(buffer.slice(0, nlIdx));
          }
          buffer = buffer.slice(nlIdx + 1);
          if (lineNum >= endLineNum) break;
        }
        // 最后一行（文件末尾无换行）
        if (pos >= fileSize && buffer.trim()) {
          lineNum++;
          if (lineNum >= startLineNum && lineNum <= endLineNum) {
            lines.push(buffer);
          }
        }
      }

      return {
        path: relPath,
        size: fileSize,
        totalLines: lineNum, // 近似值
        startLine: startLineNum,
        endLine: Math.min(endLineNum, lineNum),
        content: lines.join('\n'),
        lines: lines.length,
        hasMore: lineNum > endLineNum,
        nextHint: lineNum > endLineNum ? `还有 ${lineNum - endLineNum} 行，startLine: ${endLineNum + 1}` : undefined,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  // ── 写文件 ──────────────────────────────────────────
  writeFile(relPath, content) {
    if (isSensitiveFilePath(relPath)) {
      throw new Error(`拒绝写入敏感文件: ${relPath}。Agent 不应修改 .env、密钥等敏感文件。`);
    }
    const absolute = this.sandbox.resolve(relPath);
    const dir = path.dirname(absolute);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(absolute, content, 'utf-8');
    return { path: relPath, action: 'written', size: Buffer.byteLength(content, 'utf-8') };
  }

  // ── 删除文件（V1.4.0: 供 Rollback 使用）─────────────────
  deleteFile(relPath) {
    if (isSensitiveFilePath(relPath)) {
      throw new Error(`拒绝删除敏感文件: ${relPath}。Agent 不应删除 .env、密钥等敏感文件。`);
    }
    const absolute = this.sandbox.resolve(relPath);
    if (!fs.existsSync(absolute)) {
      throw new Error(`文件不存在: ${relPath}`);
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      throw new Error(`不是文件: ${relPath}`);
    }
    fs.unlinkSync(absolute);
    return { path: relPath, action: 'deleted', size: stat.size };
  }

  // ── 检查是否敏感 ────────────────────────────────────
  isSensitive(relPath) {
    return isSensitiveFilePath(relPath);
  }

  // ── 检查是否二进制 ───────────────────────────────────
  isBinary(relPath) {
    try {
      const absolute = this.sandbox.resolve(relPath);
      if (!fs.existsSync(absolute)) return false;
      if (isBinaryExtension(absolute)) return true;
      const fd = fs.openSync(absolute, 'r');
      try {
        const buf = Buffer.alloc(BINARY_CHECK_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, BINARY_CHECK_BYTES, 0);
        // 只检查实际读取的字节，避免未初始化区域的 0x00 误判
        return isBinaryContent(buf.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }
}

export { WorkspaceFileService, isBinaryExtension, isBinaryContent };