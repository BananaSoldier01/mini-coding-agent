/**
 * sandbox.js — Workspace 沙箱
 *
 * 所有文件操作路径必须落在 workspace 根目录内，防止路径穿越。
 */

import path from 'path';
import fs from 'fs';

class Sandbox {
  constructor(root) {
    this.root = path.resolve(root);
    // 确保根目录存在
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
  }

  /** 解析并校验路径，返回绝对路径；越界则抛错 */
  resolve(p) {
    if (!p || typeof p !== 'string') {
      throw new Error('路径不能为空');
    }
    // 去掉 drive letter / 开头的斜杠再 join，避免 path.join('/abs', '/etc/passwd') 的问题
    const cleaned = p.replace(/^[a-zA-Z]:/, '');
    const absolute = path.resolve(this.root, cleaned);
    const rel = path.relative(this.root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`路径越界: ${p} 不在 workspace 内`);
    }
    return absolute;
  }

  /** 判断路径是否在 workspace 内 */
  isInside(p) {
    try {
      this.resolve(p);
      return true;
    } catch {
      return false;
    }
  }

  /** workspace 根目录 */
  getRoot() {
    return this.root;
  }

  /** 相对路径（用于展示） */
  relative(absolute) {
    return path.relative(this.root, absolute);
  }
}

export { Sandbox };