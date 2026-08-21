/**
 * runstatus.js — Agent Run Status 状态机
 *
 * V0.4.0: 统一、有限的 Run Status。
 *
 * 状态：
 *   Thinking → Reading → Searching → Editing → Running → Waiting → Verifying → Completed
 *   任意状态 → Cancelled / Failed
 *
 * 只展示可观察的真实工作状态，不展示模型内部推理。
 */

const RUN_STATUS = {
  IDLE: 'idle',
  THINKING: 'thinking',
  READING: 'reading',
  SEARCHING: 'searching',
  EDITING: 'editing',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

const STATUS_LABELS = {
  [RUN_STATUS.IDLE]: 'Idle',
  [RUN_STATUS.THINKING]: 'Thinking',
  [RUN_STATUS.READING]: 'Reading',
  [RUN_STATUS.SEARCHING]: 'Searching',
  [RUN_STATUS.EDITING]: 'Editing',
  [RUN_STATUS.RUNNING]: 'Running',
  [RUN_STATUS.WAITING_APPROVAL]: 'Waiting for approval',
  [RUN_STATUS.VERIFYING]: 'Verifying',
  [RUN_STATUS.COMPLETED]: 'Completed',
  [RUN_STATUS.CANCELLED]: 'Cancelled',
  [RUN_STATUS.FAILED]: 'Failed',
};

const STATUS_ICONS = {
  [RUN_STATUS.IDLE]: '○',
  [RUN_STATUS.THINKING]: '●',
  [RUN_STATUS.READING]: '●',
  [RUN_STATUS.SEARCHING]: '●',
  [RUN_STATUS.EDITING]: '●',
  [RUN_STATUS.RUNNING]: '●',
  [RUN_STATUS.WAITING_APPROVAL]: '⚠',
  [RUN_STATUS.VERIFYING]: '●',
  [RUN_STATUS.COMPLETED]: '✓',
  [RUN_STATUS.CANCELLED]: '■',
  [RUN_STATUS.FAILED]: '✕',
};

// 合法状态转移
const TRANSITIONS = {
  [RUN_STATUS.IDLE]: [RUN_STATUS.THINKING],
  [RUN_STATUS.THINKING]: [RUN_STATUS.READING, RUN_STATUS.SEARCHING, RUN_STATUS.EDITING, RUN_STATUS.RUNNING, RUN_STATUS.COMPLETED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED],
  [RUN_STATUS.READING]: [RUN_STATUS.SEARCHING, RUN_STATUS.EDITING, RUN_STATUS.RUNNING, RUN_STATUS.VERIFYING, RUN_STATUS.COMPLETED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED],
  [RUN_STATUS.SEARCHING]: [RUN_STATUS.READING, RUN_STATUS.EDITING, RUN_STATUS.RUNNING, RUN_STATUS.VERIFYING, RUN_STATUS.COMPLETED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED],
  [RUN_STATUS.EDITING]: [RUN_STATUS.RUNNING, RUN_STATUS.VERIFYING, RUN_STATUS.COMPLETED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED],
  [RUN_STATUS.RUNNING]: [RUN_STATUS.VERIFYING, RUN_STATUS.COMPLETED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED],
  [RUN_STATUS.WAITING_APPROVAL]: [RUN_STATUS.THINKING, RUN_STATUS.RUNNING, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED],
  [RUN_STATUS.VERIFYING]: [RUN_STATUS.COMPLETED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED],
  [RUN_STATUS.COMPLETED]: [],
  [RUN_STATUS.CANCELLED]: [],
  [RUN_STATUS.FAILED]: [],
};

class RunStatus {
  constructor() {
    this.status = RUN_STATUS.IDLE;
    this.detail = '';
    this.transitions = [];
  }

  /** 转移状态 */
  transition(newStatus, detail = '') {
    const allowed = TRANSITIONS[this.status] || [];
    if (!allowed.includes(newStatus)) {
      // 非法转移：记录但不阻止（向前兼容）
      console.warn(`[RunStatus] 非法转移: ${this.status} → ${newStatus}`);
    }
    this.transitions.push({ from: this.status, to: newStatus, detail, ts: Date.now() });
    this.status = newStatus;
    this.detail = detail;
  }

  /** 根据 tool name 推断状态 */
  inferFromTool(toolName) {
    const map = {
      list_directory: RUN_STATUS.READING,
      read_file: RUN_STATUS.READING,
      search_files: RUN_STATUS.SEARCHING,
      write_file: RUN_STATUS.EDITING,
      edit_file: RUN_STATUS.EDITING,
      delete_file: RUN_STATUS.EDITING,
      run_command: RUN_STATUS.RUNNING,
    };
    return map[toolName] || RUN_STATUS.THINKING;
  }

  /** 获取当前状态标签 */
  get label() {
    return STATUS_LABELS[this.status] || this.status;
  }

  /** 获取当前状态图标 */
  get icon() {
    return STATUS_ICONS[this.status] || '○';
  }

  /** 是否为终态 */
  get isTerminal() {
    return [RUN_STATUS.COMPLETED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED].includes(this.status);
  }
}

export { RunStatus, RUN_STATUS, STATUS_LABELS, STATUS_ICONS };