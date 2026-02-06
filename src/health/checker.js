/**
 * 健康检查系统
 * Author: CodePothunter
 * Version: 1.0.0
 *
 * 定期检查各组件的健康状态
 */

import { spawn } from 'child_process';
import Logger from '../utils/logger.js';
import { FAULT_TOLERANCE } from '../config/constants.js';

/**
 * 健康状态枚举
 */
export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown',
};

/**
 * 健康检查器类
 */
export class HealthChecker {
  constructor(options = {}) {
    this.checkInterval = options.checkInterval || FAULT_TOLERANCE.health.checkInterval;
    this.recoveryCheckInterval = options.recoveryCheckInterval || FAULT_TOLERANCE.health.recoveryCheckInterval;
    this.intervalId = null;
    this.isRunning = false;

    // 健康状态
    this.healthState = {
      tmux: HealthStatus.UNKNOWN,
      websocket: HealthStatus.UNKNOWN,
      feishu: HealthStatus.UNKNOWN,
      overall: HealthStatus.UNKNOWN,
    };

    // 上次检查时间
    this.lastCheckTime = null;

    // 检查结果历史（用于趋势分析）
    this.checkHistory = [];
    this.maxHistorySize = 100;

    // 状态变化回调
    this.onStateChange = null;
    this.previousState = { ...this.healthState };
  }

  /**
   * 启动健康检查
   */
  start() {
    if (this.isRunning) {
      Logger.warn('健康检查已在运行');
      return;
    }

    this.isRunning = true;
    Logger.health('启动健康检查系统');

    // 立即执行一次检查
    this.checkAll();

    // 定期检查
    this.intervalId = setInterval(() => {
      this.checkAll();
    }, this.checkInterval);
  }

  /**
   * 停止健康检查
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    Logger.health('健康检查系统已停止');
  }

  /**
   * 执行所有健康检查
   */
  async checkAll() {
    this.lastCheckTime = Date.now();

    const results = {
      timestamp: this.lastCheckTime,
      tmux: await this.checkTmux(),
      websocket: await this.checkWebSocket(),
      feishu: await this.checkFeishu(),
    };

    // 更新健康状态
    this.updateHealthState(results);

    // 记录历史
    this.recordHistory(results);

    // 触发状态变化回调
    this.notifyStateChange();
  }

  /**
   * 检查 tmux 会话状态
   * @returns {Object} - 检查结果
   */
  async checkTmux() {
    try {
      // 检查 tmux 服务器是否运行
      const result = await this.execCommand('tmux', ['list-sessions'], { timeout: 5000 });

      if (result.error) {
        return {
          status: HealthStatus.UNHEALTHY,
          message: result.error,
          details: { code: result.code },
        };
      }

      // 解析会话列表
      const sessions = result.output
        .split('\n')
        .filter(line => line.trim())
        .map(line => line.split(':')[0]);

      return {
        status: HealthStatus.HEALTHY,
        message: `发现 ${sessions.length} 个 tmux 会话`,
        details: { sessions },
      };
    } catch (error) {
      return {
        status: HealthStatus.UNHEALTHY,
        message: error.message,
        details: {},
      };
    }
  }

  /**
   * 检查 WebSocket 连接状态
   * @returns {Object} - 检查结果
   */
  async checkWebSocket(wsClient = null) {
    if (!wsClient) {
      return {
        status: HealthStatus.UNKNOWN,
        message: 'WebSocket 客户端未提供',
        details: {},
      };
    }

    try {
      // 检查连接状态
      // 注意：这里需要根据实际的 WebSocket 客户端 API 调整
      const isConnected = wsClient.isConnected?.() ?? true;

      return {
        status: isConnected ? HealthStatus.HEALTHY : HealthStatus.DEGRADED,
        message: isConnected ? 'WebSocket 已连接' : 'WebSocket 未连接',
        details: { isConnected },
      };
    } catch (error) {
      return {
        status: HealthStatus.UNHEALTHY,
        message: error.message,
        details: {},
      };
    }
  }

  /**
   * 检查飞书 API 可用性
   * @returns {Object} - 检查结果
   */
  async checkFeishu() {
    // 这里应该通过 messenger 实例检查
    // 由于是独立模块，暂时返回 UNKNOWN
    return {
      status: HealthStatus.UNKNOWN,
      message: '飞书 API 检查需要 messenger 实例',
      details: {},
    };
  }

  /**
   * 更新健康状态
   * @param {Object} results - 检查结果
   */
  updateHealthState(results) {
    this.healthState.tmux = results.tmux.status;
    this.healthState.websocket = results.websocket.status;
    this.healthState.feishu = results.feishu.status;

    // 计算整体健康状态
    const statuses = [
      this.healthState.tmux,
      this.healthState.websocket,
      this.healthState.feishu,
    ].filter(s => s !== HealthStatus.UNKNOWN);

    if (statuses.length === 0) {
      this.healthState.overall = HealthStatus.UNKNOWN;
    } else if (statuses.some(s => s === HealthStatus.UNHEALTHY)) {
      this.healthState.overall = HealthStatus.UNHEALTHY;
    } else if (statuses.some(s => s === HealthStatus.DEGRADED)) {
      this.healthState.overall = HealthStatus.DEGRADED;
    } else {
      this.healthState.overall = HealthStatus.HEALTHY;
    }
  }

  /**
   * 记录检查历史
   * @param {Object} results - 检查结果
   */
  recordHistory(results) {
    this.checkHistory.push({
      ...results,
      overall: this.healthState.overall,
    });

    // 限制历史大小
    if (this.checkHistory.length > this.maxHistorySize) {
      this.checkHistory.shift();
    }
  }

  /**
   * 通知状态变化
   */
  notifyStateChange() {
    if (!this.onStateChange) {
      return;
    }

    const hasChanged = Object.keys(this.healthState).some(key => {
      return this.healthState[key] !== this.previousState[key];
    });

    if (hasChanged) {
      try {
        this.onStateChange(this.healthState, this.previousState);
        this.previousState = { ...this.healthState };
      } catch (error) {
        Logger.error(`状态变化回调失败: ${error.message}`);
      }
    }
  }

  /**
   * 获取当前健康状态
   * @returns {Object}
   */
  getHealthState() {
    return { ...this.healthState };
  }

  /**
   * 获取检查历史
   * @param {number} limit - 返回的记录数
   * @returns {Array}
   */
  getHistory(limit = 10) {
    return this.checkHistory.slice(-limit);
  }

  /**
   * 执行命令
   * @param {string} command - 命令
   * @param {Array<string>} args - 参数
   * @param {Object} options - 选项
   * @returns {Promise<Object>}
   */
  execCommand(command, args, options = {}) {
    return new Promise((resolve) => {
      const timeout = options.timeout || 5000;
      let output = '';
      let errorOutput = '';
      let timedOut = false;

      const proc = spawn(command, args);

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        // 再给 2 秒优雅退出
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 2000);
      }, timeout);

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ error: '命令执行超时', code: -1, output: '' });
        } else {
          resolve({ error: errorOutput, code, output });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ error: err.message, code: -1, output: '' });
      });
    });
  }

  /**
   * 设置状态变化回调
   * @param {Function} callback - 回调函数
   */
  onStateChanged(callback) {
    this.onStateChange = callback;
  }

  /**
   * 获取健康报告
   * @returns {string}
   */
  getReport() {
    const state = this.healthState;
    const lines = [
      '📊 健康检查报告',
      `tmux: ${this.getStatusIcon(state.tmux)} ${state.tmux}`,
      `websocket: ${this.getStatusIcon(state.websocket)} ${state.websocket}`,
      `feishu: ${this.getStatusIcon(state.feishu)} ${state.feishu}`,
      `整体: ${this.getStatusIcon(state.overall)} ${state.overall}`,
      `上次检查: ${this.lastCheckTime ? new Date(this.lastCheckTime).toLocaleString() : '从未'}`,
    ];
    return lines.join('\n');
  }

  /**
   * 获取状态图标
   * @param {string} status - 状态
   * @returns {string}
   */
  getStatusIcon(status) {
    switch (status) {
      case HealthStatus.HEALTHY:
        return '🟢';
      case HealthStatus.DEGRADED:
        return '🟡';
      case HealthStatus.UNHEALTHY:
        return '🔴';
      default:
        return '⚪';
    }
  }
}

export default HealthChecker;
