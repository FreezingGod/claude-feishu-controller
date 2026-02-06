/**
 * 降级管理器
 * Author: CodePothunter
 * Version: 1.0.0
 *
 * 管理服务降级策略和自动恢复
 */

import Logger from '../utils/logger.js';
import { FAULT_TOLERANCE } from '../config/constants.js';
import { HealthStatus } from './checker.js';

/**
 * 降级级别
 */
export const FallbackLevel = {
  NONE: 'none',          // 正常运行
  MINOR: 'minor',        // 轻度降级
  MODERATE: 'moderate',  // 中度降级
  SEVERE: 'severe',      // 严重降级
};

/**
 * 降级策略配置
 */
const FALLBACK_STRATEGIES = {
  // 飞书 API 失败时的降级策略
  feishu: {
    enabled: true,
    fallbackLevel: FallbackLevel.MODERATE,
    messageQueue: true,      // 启用消息队列
    retryAttempts: 3,        // 重试次数
    alertOnFailure: true,    // 失败时发送警告
  },
  // tmux 会话失败时的降级策略
  tmux: {
    enabled: true,
    fallbackLevel: FallbackLevel.SEVERE,
    alertOnFailure: true,
    attemptRecovery: true,   // 尝试自动恢复
  },
  // WebSocket 失败时的降级策略
  websocket: {
    enabled: true,
    fallbackLevel: FallbackLevel.MINOR,
    autoReconnect: true,     // 自动重连
    alertOnDisconnect: true,
  },
};

/**
 * 降级管理器类
 */
export class FallbackManager {
  constructor(options = {}) {
    this.currentLevel = FallbackLevel.NONE;
    this.activeFallbacks = new Set();
    this.fallbackHistory = [];
    this.maxHistorySize = 100;

    // 降级状态
    this.fallbackStates = {
      feishu: { active: false, since: null, failureCount: 0 },
      tmux: { active: false, since: null, failureCount: 0 },
      websocket: { active: false, since: null, failureCount: 0 },
    };

    // 恢复检测间隔
    this.recoveryCheckInterval = options.recoveryCheckInterval ||
      FAULT_TOLERANCE.health.recoveryCheckInterval;
    this.recoveryTimer = null;

    // 回调函数
    this.onFallbackActivate = null;
    this.onFallbackDeactivate = null;
    this.onLevelChange = null;
  }

  /**
   * 启动降级管理器
   */
  start() {
    Logger.fallback('启动降级管理器');
    this.startRecoveryCheck();
  }

  /**
   * 停止降级管理器
   */
  stop() {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    Logger.fallback('降级管理器已停止');
  }

  /**
   * 启动恢复检测
   */
  startRecoveryCheck() {
    this.recoveryTimer = setInterval(() => {
      this.checkRecovery();
    }, this.recoveryCheckInterval);
  }

  /**
   * 检查是否可以恢复
   */
  async checkRecovery() {
    for (const [service, state] of Object.entries(this.fallbackStates)) {
      if (!state.active) {
        continue;
      }

      const strategy = FALLBACK_STRATEGIES[service];
      if (!strategy || !strategy.attemptRecovery) {
        continue;
      }

      // 这里应该调用实际的健康检查
      // 暂时使用模拟逻辑
      const isHealthy = await this.checkServiceHealth(service);

      if (isHealthy) {
        Logger.fallback(`${service} 服务已恢复，解除降级`);
        this.deactivateFallback(service);
      }
    }
  }

  /**
   * 检查服务健康状态
   * @param {string} service - 服务名称
   * @returns {Promise<boolean>}
   */
  async checkServiceHealth(service) {
    // 这里应该调用健康检查器
    // 暂时返回 false，需要实际集成 HealthChecker
    return false;
  }

  /**
   * 激活降级
   * @param {string} service - 服务名称
   * @param {string} reason - 降级原因
   */
  activateFallback(service, reason = 'unknown') {
    const strategy = FALLBACK_STRATEGIES[service];
    if (!strategy || !strategy.enabled) {
      Logger.debug(`${service} 降级策略未启用`);
      return;
    }

    if (this.fallbackStates[service].active) {
      // 已在降级状态，增加失败计数
      this.fallbackStates[service].failureCount++;
      Logger.warn(`${service} 降级持续中 (失败次数: ${this.fallbackStates[service].failureCount})`);
      return;
    }

    const state = this.fallbackStates[service];
    state.active = true;
    state.since = Date.now();
    state.failureCount = 1;

    this.activeFallbacks.add(service);
    this.recordHistory({
      action: 'activate',
      service,
      reason,
      timestamp: Date.now(),
    });

    Logger.warn(`🚨 ${service} 服务降级已激活: ${reason}`);

    // 更新降级级别
    this.updateFallbackLevel();

    // 触发回调
    if (this.onFallbackActivate) {
      try {
        this.onFallbackActivate(service, reason);
      } catch (error) {
        Logger.error(`降级激活回调失败: ${error.message}`);
      }
    }
  }

  /**
   * 解除降级
   * @param {string} service - 服务名称
   */
  deactivateFallback(service) {
    if (!this.fallbackStates[service].active) {
      return;
    }

    const state = this.fallbackStates[service];
    state.active = false;
    state.since = null;
    state.failureCount = 0;

    this.activeFallbacks.delete(service);
    this.recordHistory({
      action: 'deactivate',
      service,
      timestamp: Date.now(),
    });

    Logger.info(`✅ ${service} 服务降级已解除`);

    // 更新降级级别
    this.updateFallbackLevel();

    // 触发回调
    if (this.onFallbackDeactivate) {
      try {
        this.onFallbackDeactivate(service);
      } catch (error) {
        Logger.error(`降级解除回调失败: ${error.message}`);
      }
    }
  }

  /**
   * 更新降级级别
   */
  updateFallbackLevel() {
    const previousLevel = this.currentLevel;

    if (this.activeFallbacks.size === 0) {
      this.currentLevel = FallbackLevel.NONE;
    } else {
      // 根据活动降级服务计算级别
      let maxLevel = 0;
      for (const service of this.activeFallbacks) {
        const strategy = FALLBACK_STRATEGIES[service];
        if (!strategy) continue;

        const levelValue = this.getLevelValue(strategy.fallbackLevel);
        if (levelValue > maxLevel) {
          maxLevel = levelValue;
        }
      }

      if (maxLevel >= 3) this.currentLevel = FallbackLevel.SEVERE;
      else if (maxLevel >= 2) this.currentLevel = FallbackLevel.MODERATE;
      else this.currentLevel = FallbackLevel.MINOR;
    }

    if (previousLevel !== this.currentLevel && this.onLevelChange) {
      try {
        this.onLevelChange(this.currentLevel, previousLevel);
      } catch (error) {
        Logger.error(`降级级别变化回调失败: ${error.message}`);
      }
    }
  }

  /**
   * 获取降级级别数值
   * @param {string} level - 降级级别
   * @returns {number}
   */
  getLevelValue(level) {
    switch (level) {
      case FallbackLevel.SEVERE: return 3;
      case FallbackLevel.MODERATE: return 2;
      case FallbackLevel.MINOR: return 1;
      default: return 0;
    }
  }

  /**
   * 记录降级历史
   * @param {Object} entry - 历史条目
   */
  recordHistory(entry) {
    this.fallbackHistory.push(entry);

    if (this.fallbackHistory.length > this.maxHistorySize) {
      this.fallbackHistory.shift();
    }
  }

  /**
   * 获取降级状态
   * @returns {Object}
   */
  getStatus() {
    return {
      level: this.currentLevel,
      activeFallbacks: Array.from(this.activeFallbacks),
      services: { ...this.fallbackStates },
    };
  }

  /**
   * 获取降级历史
   * @param {number} limit - 返回的记录数
   * @returns {Array}
   */
  getHistory(limit = 10) {
    return this.fallbackHistory.slice(-limit);
  }

  /**
   * 获取降级报告
   * @returns {string}
   */
  getReport() {
    const status = this.getStatus();
    const levelIcon = this.getLevelIcon(status.level);

    const lines = [
      `🔄 降级状态报告`,
      `当前级别: ${levelIcon} ${status.level}`,
      ``,
      `活动降级:`,
    ];

    for (const service of status.activeFallbacks) {
      const state = status.services[service];
      const duration = state.since ? Math.floor((Date.now() - state.since) / 1000) : 0;
      lines.push(`  - ${service}: ${duration}s (失败次数: ${state.failureCount})`);
    }

    if (status.activeFallbacks.length === 0) {
      lines.push('  (无活动降级)');
    }

    return lines.join('\n');
  }

  /**
   * 获取级别图标
   * @param {string} level - 降级级别
   * @returns {string}
   */
  getLevelIcon(level) {
    switch (level) {
      case FallbackLevel.NONE: return '🟢';
      case FallbackLevel.MINOR: return '🟡';
      case FallbackLevel.MODERATE: return '🟠';
      case FallbackLevel.SEVERE: return '🔴';
      default: return '⚪';
    }
  }

  /**
   * 设置降级激活回调
   * @param {Function} callback - 回调函数
   */
  onActivate(callback) {
    this.onFallbackActivate = callback;
  }

  /**
   * 设置降级解除回调
   * @param {Function} callback - 回调函数
   */
  onDeactivate(callback) {
    this.onFallbackDeactivate = callback;
  }

  /**
   * 设置级别变化回调
   * @param {Function} callback - 回调函数
   */
  onLevelChanged(callback) {
    this.onLevelChange = callback;
  }
}

export default FallbackManager;
