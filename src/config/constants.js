/**
 * 常量定义
 * Author: CodePothunter
 * Version: 1.1.0 - 添加容错配置
 */

// 默认配置值
export const DEFAULTS = {
  SESSION_NAME: 'claude-code',
  SESSION_FILE: '/tmp/claude-feishu-last-session.txt',
  POLL_INTERVAL: 2000,
  BUFFER_SIZE: 500,
  MAX_BUFFER_LENGTH: 50000,
  MIN_BUFFER_LENGTH: 20000,
  DEDUPLICATION_TTL: 300000,
  DEDUPLICATION_MAX_SIZE: 1000,
  DEDUPLICATION_CLEANUP_INTERVAL: 60000,
};

// 容错配置
export const FAULT_TOLERANCE = {
  retries: {
    feishu: { maxAttempts: 3, delays: [1000, 2000, 5000] },
    command: { maxAttempts: 2, delays: [1000, 3000] },
    websocket: { maxAttempts: -1, baseDelay: 3000, maxDelay: 30000 }, // -1 = 无限
  },
  timeouts: {
    feishu: 10000,
    command: 30000,
    tmux: 5000,
    processCleanup: 5000,
  },
  health: {
    checkInterval: 30000,
    recoveryCheckInterval: 60000,
  },
};

// 状态优先级
export const STATE_PRIORITY = {
  TAB_SELECTION: 10,
  EXIT_PLAN_MODE: 9,
  ERROR: 8,
  ASKING_QUESTION: 7,
  CONFIRMATION: 6,
  PLAN_MODE: 5,
  TESTING: 4,
  GIT_OPERATION: 3,
  INPUT_PROMPT: 2,
  IDLE: 1,
};

// 消息类型
export const MESSAGE_TYPES = {
  TEXT: 'text',
  INTERACTIVE: 'interactive',
};

// 命令前缀
export const COMMAND_PREFIXES = {
  BRIDGE: '/',
  EXECUTE: '!',
};

// 确认词映射
export const CONFIRMATION_WORDS = {
  YES: ['yes', 'y', 'confirm', '确认', '好的', 'ok'],
  ENTER: ['confirm', '确认', '好的', 'ok', 'continue', '继续'],
  NO: ['no', 'n', 'cancel', '取消', 'skip', '跳过'],
};

// 会话名称验证规则
export const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

// 轮询间隔（毫秒）根据状态动态调整
export const POLL_INTERVALS = {
  EXECUTING: 5000,
  IDLE: 10000,
  WAITING_INPUT: 1000,
  DEFAULT: 2000,
};

// Discord 消息长度限制
export const DISCORD = {
  MAX_MESSAGE_LENGTH: 2000,
  MAX_EMBED_DESCRIPTION: 4096,
  SPLIT_THRESHOLD: 1800,
};

// 去重配置
export const DEDUPLICATION = {
  TTL: 300000,           // 5分钟
  MAX_SIZE: 1000,        // 最多缓存1000条
  CLEANUP_INTERVAL: 60000,  // 1分钟清理一次
};
