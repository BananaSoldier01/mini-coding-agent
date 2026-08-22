/**
 * context/project.js — Project Instructions (AGENTS.md) 加载
 *
 * V0.5.0.1
 * - 只支持 workspace 根目录 /AGENTS.md
 * - 通过 WorkspaceFileService 读取（遵守 workspace boundary / symlink / binary / size）
 * - 每 Run 重新解析，不做 cache
 * - 正确读取 readFile().content（readFile 返回对象，不是字符串）
 */

const AGENTS_FILE = 'AGENTS.md';
const PROJECT_INSTRUCTIONS_MAX_CHARS = 32000;

class ProjectInstructions {
  constructor(fileService) {
    this.fileService = fileService;
  }

  /**
   * 加载 Project Instructions。
   * 返回 { loaded, source, content, truncated, originalLength, loadedLength }
   */
  load(workspace) {
    const result = {
      loaded: false,
      source: AGENTS_FILE,
      content: '',
      truncated: false,
      originalLength: 0,
      loadedLength: 0,
    };

    try {
      // 检查文件是否存在
      const exists = this.fileService.fileExists(AGENTS_FILE);
      if (!exists) {
        return result;
      }

      // 读取内容 — readFile() 返回 { path, size, content, totalLines, ... }
      const fileData = this.fileService.readFile(AGENTS_FILE);

      // P0-1: 正确提取 content 字段
      if (!fileData || typeof fileData !== 'object') {
        return result;
      }

      const content = fileData.content;
      if (content == null || content === '') {
        return result;
      }

      result.loaded = true;
      result.originalLength = content.length;
      result.loadedLength = content.length;

      if (content.length > PROJECT_INSTRUCTIONS_MAX_CHARS) {
        result.content = content.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS);
        result.truncated = true;
        result.loadedLength = PROJECT_INSTRUCTIONS_MAX_CHARS;
      } else {
        result.content = content;
      }

      return result;
    } catch (err) {
      // 文件不存在 / 权限问题 → 不加载
      return result;
    }
  }
}

export { ProjectInstructions, PROJECT_INSTRUCTIONS_MAX_CHARS, AGENTS_FILE };