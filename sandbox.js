/**
 * sandbox.js — Workspace 沙箱
 *
 * 所有文件操作路径必须落在 workspace 根目录内，防止路径穿越。
 * 检测并拒绝 symlink 逃逸。
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
    // 缓存 real root（解析符号链接）
    this.realRoot = fs.realpathSync(this.root);
  }

  /**
   * 解析并校验路径，返回绝对路径；越界则抛错。
   * 会检测 symlink 逃逸。
   */
  resolve(p) {
    if (!p || typeof p !== 'string') {
      throw new Error('路径不能为空');
    }
    // 去掉 drive letter
    const cleaned = p.replace(/^[a-zA-Z]:/, '');
    const absolute = path.resolve(this.root, cleaned);

    // 检查路径是否在 workspace 内（字符串级别）
    const rel = path.relative(this.root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`路径越界: ${p} 不在 workspace 内`);
    }

    // 检查 symlink 逃逸：解析真实路径
    try {
      const realPath = fs.realpathSync(absolute);
      const realRel = path.relative(this.realRoot, realPath);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw Error(`Symlink 逃逸: ${p} 解析到 workspace 外: ${realPath}`);
      }
    } catch (err) {
      if (err.message.startsWith('Symlink 逃逸')) throw err;
      // 文件不存在时 realpathSync 会抛错，此时路径本身合法，放行
      // 但要确保父目录合法
      let dir = path.dirname(absolute);
      while (dir !== this.root && dir.startsWith(this.root)) {
        try {
          const realDir = fs.realpathSync(dir);
          const realDirRel = path.relative(this.realRoot, realDir);
          if (realDirRel.startsWith('..') || path.isAbsolute(realDirRel)) {
            throw new Error(`Symlink 逃逸: 父目录 ${dir} 解析到 workspace 外`);
          }
          break;
        } catch (e) {
          if (e.message.startsWith('Symlink 逃逸')) throw e;
          dir = path.dirname(dir);
        }
      }
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