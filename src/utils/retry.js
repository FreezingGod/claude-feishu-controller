/**
 * 重试工具
 * Author: CodePothunter
 * Version: 1.0.0
 *
 * 提供通用的重试机制，支持指数退避策略
 */

import Logger from './logger.js';

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  maxAttempts: 3,
  delays: [1000, 2000, 5000],
  baseDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  isRetryable: () => true,
  onRetry: null,
  jitter: true,
};

/**
 * 带抖动的延迟
 * @param {number} ms - 基础延迟时间
 * @param {number} jitterRatio - 抖动比例 (0-1)
 * @returns {Promise<void>}
 */
async function delayWithJitter(ms, jitterRatio = 0.1) {
  const jitter = Math.random() * ms * jitterRatio;
  const actualDelay = ms + jitter;
  await new Promise(resolve => setTimeout(resolve, actualDelay));
}

/**
 * 计算指数退避延迟
 * @param {number} attempt - 尝试次数（从 1 开始）
 * @param {Object} config - 配置
 * @returns {number} - 延迟时间（毫秒）
 */
function calculateBackoff(attempt, config) {
  // 如果有预定义的延迟数组，使用它
  if (config.delays && config.delays.length > 0) {
    const index = Math.min(attempt - 1, config.delays.length - 1);
    return config.delays[index];
  }

  // 否则使用指数退避公式
  const delay = Math.min(
    config.baseDelay * Math.pow(config.multiplier, attempt - 1),
    config.maxDelay
  );
  return delay;
}

/**
 * 带重试的异步函数执行
 * @param {Function} fn - 要执行的异步函数
 * @param {Object} options - 配置选项
 * @returns {Promise<any>} - 函数执行结果
 */
export async function withRetry(fn, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  // 支持 -1 表示无限重试
  const infiniteRetries = config.maxAttempts === -1;
  let lastError = null;

  for (let attempt = 1; infiniteRetries || attempt <= config.maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        Logger.info(`重试成功 (第 ${attempt} 次尝试)`);
      }
      return result;
    } catch (error) {
      lastError = error;

      // 检查是否可重试
      const isRetryable = typeof config.isRetryable === 'function'
        ? config.isRetryable(error)
        : config.isRetryable;

      if (!isRetryable) {
        Logger.debug(`错误不可重试: ${error.message}`);
        throw error;
      }

      // 检查是否还有重试机会
      if (!infiniteRetries && attempt >= config.maxAttempts) {
        Logger.error(`达到最大重试次数 (${config.maxAttempts})`);
        throw error;
      }

      // 计算延迟时间
      const delay = calculateBackoff(attempt, config);

      Logger.warn(`第 ${attempt} 次尝试失败: ${error.message}，${delay}ms 后重试...`);

      // 执行回调
      if (config.onRetry) {
        try {
          await config.onRetry(error, attempt);
        } catch (callbackError) {
          Logger.error(`onRetry 回调失败: ${callbackError.message}`);
        }
      }

      // 延迟
      if (config.jitter) {
        await delayWithJitter(delay);
      } else {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * 创建一个带重试的函数包装器
 * @param {Function} fn - 原始函数
 * @param {Object} options - 重试配置
 * @returns {Function} - 包装后的函数
 */
export function createRetryWrapper(fn, options = {}) {
  return async function (...args) {
    return withRetry(() => fn.apply(this, args), options);
  };
}

/**
 * 判断错误是否可重试的辅助函数
 */
export const RetryableErrors = {
  /**
   * 检查是否是网络错误
   */
  isNetworkError(error) {
    if (!error) return false;
    const message = error.message?.toLowerCase() || '';
    const code = error.code || '';
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('etimedout') ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      code === 'EAI_AGAIN'
    );
  },

  /**
   * 检查是否是 HTTP 5xx 错误
   */
  isServerError(error) {
    if (!error || !error.response) return false;
    const status = error.response.status;
    return status >= 500 && status < 600;
  },

  /**
   * 检查是否是 HTTP 429 限流错误
   */
  isRateLimitError(error) {
    if (!error || !error.response) return false;
    return error.response.status === 429;
  },

  /**
   * 检查飞书 API 错误是否可重试
   */
  isFeishuRetryableError(error) {
    if (!error) return false;

    // 网络错误可重试
    if (this.isNetworkError(error)) return true;

    // 检查飞书错误码
    if (error.code) {
      const retryableCodes = [9999, 10003, 10004, 10008]; // 系统错误、超时等
      return retryableCodes.includes(error.code);
    }

    // HTTP 5xx 可重试
    if (this.isServerError(error)) return true;

    // 429 限流可重试
    if (this.isRateLimitError(error)) return true;

    return false;
  },

  /**
   * 检查命令执行错误是否可重试
   */
  isCommandRetryableError(error) {
    if (!error) return false;

    const message = error.message?.toLowerCase() || '';

    // tmux 临时错误
    if (message.includes('tmux') &&
        (message.includes('failed') || message.includes('timeout'))) {
      return true;
    }

    // 进程相关错误
    if (message.includes('process') &&
        (message.includes('killed') || message.includes('terminated'))) {
      return false; // 进程被杀通常不可重试
    }

    return false;
  },
};

/**
 * 预定义的重试配置
 */
export const RetryConfigs = {
  // 飞书消息发送
  feishu: {
    maxAttempts: 3,
    delays: [1000, 2000, 5000],
    isRetryable: (err) => RetryableErrors.isFeishuRetryableError(err),
  },

  // 命令执行
  command: {
    maxAttempts: 2,
    delays: [1000, 3000],
    isRetryable: (err) => RetryableErrors.isCommandRetryableError(err),
  },

  // WebSocket 连接
  websocket: {
    maxAttempts: -1, // 无限重试
    baseDelay: 3000,
    maxDelay: 30000,
    multiplier: 1.5,
    isRetryable: (err) => RetryableErrors.isNetworkError(err),
  },

  // HTTP 请求
  http: {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 10000,
    multiplier: 2,
    isRetryable: (err) =>
      RetryableErrors.isNetworkError(err) ||
      RetryableErrors.isServerError(err) ||
      RetryableErrors.isRateLimitError(err),
  },

  // 快速重试（用于临时错误）
  quick: {
    maxAttempts: 2,
    delays: [500, 1000],
    isRetryable: () => true,
  },
};

/**
 * 重试队列 - 用于延迟重试
 */
export class RetryQueue {
  constructor(options = {}) {
    this.queue = [];
    this.processing = false;
    this.maxSize = options.maxSize || 1000;
    this.maxRetryDelay = options.maxRetryDelay || 60000; // 1分钟
  }

  /**
   * 添加到重试队列
   * @param {Function} fn - 要重试的函数
   * @param {number} delay - 延迟时间
   * @param {number} maxAttempts - 最大尝试次数
   */
  async add(fn, delay = 1000, maxAttempts = 3) {
    if (this.queue.length >= this.maxSize) {
      Logger.warn('重试队列已满，丢弃最旧的条目');
      this.queue.shift();
    }

    const item = {
      fn,
      delay: Math.min(delay, this.maxRetryDelay),
      attempts: 0,
      maxAttempts,
      timestamp: Date.now(),
    };

    this.queue.push(item);
    Logger.debug(`添加到重试队列，当前队列长度: ${this.queue.length}`);

    if (!this.processing) {
      this.process();
    }
  }

  /**
   * 处理队列
   */
  async process() {
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();

      if (item.attempts >= item.maxAttempts) {
        Logger.warn(`重试队列项达到最大尝试次数，丢弃`);
        continue;
      }

      // 等待延迟时间
      const elapsed = Date.now() - item.timestamp;
      const remainingDelay = Math.max(0, item.delay - elapsed);

      if (remainingDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, remainingDelay));
      }

      item.attempts++;
      item.timestamp = Date.now();

      try {
        await item.fn();
        Logger.debug('重试队列项执行成功');
      } catch (error) {
        Logger.error(`重试队列项执行失败: ${error.message}`);

        if (item.attempts < item.maxAttempts) {
          // 重新加入队列，使用指数退避
          item.delay = Math.min(item.delay * 2, this.maxRetryDelay);
          this.queue.push(item);
        }
      }
    }

    this.processing = false;
  }

  /**
   * 清空队列
   */
  clear() {
    this.queue = [];
    Logger.debug('重试队列已清空');
  }

  /**
   * 获取队列长度
   */
  get length() {
    return this.queue.length;
  }
}

export default withRetry;
