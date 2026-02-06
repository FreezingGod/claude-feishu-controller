/**
 * 配置加载和验证
 * Author: CodePothunter
 * Version: 1.0.0
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULTS } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量
dotenv.config({ path: path.join(process.cwd(), '.env') });

/**
 * 配置验证错误类
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 验证必需的环境变量
 */
function validateRequired(vars) {
  const missing = [];
  for (const [key, value] of Object.entries(vars)) {
    if (!value) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `缺少必要的环境变量: ${missing.join(', ')}\n` +
      `请在 .env 文件中配置这些变量`
    );
  }
}

/**
 * 飞书配置
 */
export const feishu = {
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
  userChatId: process.env.USER_CHAT_ID || '',
};

/**
 * 会话配置
 */
export const session = {
  file: process.env.SESSION_FILE || DEFAULTS.SESSION_FILE,
  defaultName: process.env.DEFAULT_SESSION_NAME || DEFAULTS.SESSION_NAME,
};

/**
 * 监控配置
 */
export const monitor = {
  pollInterval: parseInt(process.env.POLL_INTERVAL || String(DEFAULTS.POLL_INTERVAL)),
  bufferSize: parseInt(process.env.BUFFER_SIZE || String(DEFAULTS.BUFFER_SIZE)),
  maxBufferLength: parseInt(process.env.MAX_BUFFER_LENGTH || String(DEFAULTS.MAX_BUFFER_LENGTH)),
  minBufferLength: parseInt(process.env.MIN_BUFFER_LENGTH || String(DEFAULTS.MIN_BUFFER_LENGTH)),
};

/**
 * 日志配置
 */
export const logger = {
  level: process.env.LOG_LEVEL || 'info',
  file: process.env.LOG_FILE || '',
};

/**
 * 去重配置
 */
export const deduplication = {
  ttl: parseInt(process.env.DEDUPLICATION_TTL || String(DEFAULTS.DEDUPLICATION_TTL)),
  maxSize: parseInt(process.env.DEDUPLICATION_MAX_SIZE || String(DEFAULTS.DEDUPLICATION_MAX_SIZE)),
  cleanupInterval: parseInt(process.env.DEDUPLICATION_CLEANUP_INTERVAL || String(DEFAULTS.DEDUPLICATION_CLEANUP_INTERVAL)),
  // 持久化存储路径
  storageFile: process.env.DEDUPLICATION_STORAGE_FILE || '/tmp/claude-feishu-dedup.json',
};

/**
 * 验证所有配置
 */
export function validateConfig() {
  validateRequired({
    FEISHU_APP_ID: feishu.appId,
    FEISHU_APP_SECRET: feishu.appSecret,
    USER_CHAT_ID: feishu.userChatId,
  });

  // 验证数值范围
  if (monitor.pollInterval < 100) {
    throw new ConfigError('POLL_INTERVAL 不能小于 100ms');
  }
  if (monitor.bufferSize < 10) {
    throw new ConfigError('BUFFER_SIZE 不能小于 10');
  }
}

/**
 * 导出完整配置对象
 */
export const config = {
  feishu,
  session,
  monitor,
  logger,
  deduplication,
};

/**
 * 获取配置摘要（用于日志显示）
 */
export function getConfigSummary() {
  return {
    appId: feishu.appId,
    sessionFile: session.file,
    defaultSession: session.defaultName,
    pollInterval: monitor.pollInterval,
    bufferSize: monitor.bufferSize,
  };
}

export default config;
