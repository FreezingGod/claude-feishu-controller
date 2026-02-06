/**
 * 进程管理器
 * Author: CodePothunter
 * Version: 1.0.0
 *
 * 统一管理所有 spawn 的子进程
 * 提供进程跟踪、超时监控、自动清理等功能
 */

import { spawn } from 'child_process';
import Logger from './logger.js';

/**
 * 进条目类型
 * @typedef {Object} ProcessEntry
 * @property {ChildProcess} process - 子进程实例
 * @property {string} command - 命令名称
 * @property {Array<string>} args - 命令参数
 * @property {number} spawnTime - 生成时间
 * @property {number} timeout - 超时时间（毫秒）
 * @property {NodeJS.Timeout|null} timeoutTimer - 超时定时器
 * @property {boolean} killed - 是否已被杀死
 * @property {Function} onExit - 退出回调
 */

/**
 * 进程管理器类
 */
export class ProcessManager {
  constructor() {
    // Map<processId, ProcessEntry>
    this.processes = new Map();
    this.nextId = 1;
    this.cleanupInterval = null;
    this.isShuttingDown = false;
    this.stats = {
      totalSpawned: 0,
      totalCompleted: 0,
      totalKilled: 0,
      totalTimeout: 0,
    };
  }

  /**
   * 启动进程管理器
   */
  start() {
    // 定期清理已完成进程的记录
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // 每分钟清理一次

    Logger.debug('进程管理器已启动');
  }

  /**
   * 停止进程管理器并清理所有进程
   */
  async stop() {
    this.isShuttingDown = true;

    Logger.info(`正在停止进程管理器，活动进程数: ${this.processes.size}`);

    // 停止清理定时器
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // 杀死所有活动进程
    await this.killAll();

    Logger.info('进程管理器已停止');
  }

  /**
   * 生成一个进程
   * @param {string} command - 命令
   * @param {Array<string>} args - 参数
   * @param {Object} options - 选项
   * @returns {ChildProcess} - 子进程实例
   */
  spawn(command, args = [], options = {}) {
    const {
      timeout = 30000, // 默认 30 秒超时
      onExit = null,
      onError = null,
      killSignal = 'SIGTERM',
      ...spawnOptions
    } = options;

    const processId = this.nextId++;
    const spawnTime = Date.now();

    Logger.debug(`生成进程 #${processId}: ${command} ${args.join(' ')}`);

    try {
      const childProcess = spawn(command, args, spawnOptions);

      // 创建进程条目
      const entry = {
        process: childProcess,
        command,
        args,
        spawnTime,
        timeout,
        timeoutTimer: null,
        sigkillTimer: null,     // SIGKILL 延迟定时器引用
        killed: false,
        onExit,
        onError,
        killSignal,
      };

      this.processes.set(processId, entry);
      this.stats.totalSpawned++;

      // 设置超时监控
      if (timeout > 0) {
        entry.timeoutTimer = setTimeout(() => {
          Logger.warn(`进程 #${processId} 超时 (${timeout}ms)，准备终止`);
          this.kill(processId, 'SIGTERM');
          this.stats.totalTimeout++;

          // 如果 SIGTERM 失败，5秒后使用 SIGKILL
          if (!entry.killed) {
            entry.sigkillTimer = setTimeout(() => {
              const currentEntry = this.processes.get(processId);
              // 双重检查：进程是否仍存在且未被杀死
              if (currentEntry && !currentEntry.killed) {
                Logger.warn(`进程 #${processId} 未能优雅终止，使用 SIGKILL`);
                this.kill(processId, 'SIGKILL');
              }
            }, 5000);
          }
        }, timeout);
      }

      // 处理进程退出
      childProcess.on('exit', (code, signal) => {
        const duration = Date.now() - spawnTime;
        Logger.debug(`进程 #${processId} 退出 (code: ${code}, signal: ${signal}, duration: ${duration}ms)`);

        // 清除所有定时器
        this._clearEntryTimers(entry);

        if (!entry.killed) {
          this.stats.totalCompleted++;
        }

        // 从活动进程列表移除
        this.processes.delete(processId);

        // 调用退出回调
        if (entry.onExit) {
          try {
            entry.onExit(code, signal);
          } catch (error) {
            Logger.error(`进程 #${processId} 退出回调失败: ${error.message}`);
          }
        }
      });

      // 处理进程错误
      childProcess.on('error', (error) => {
        Logger.error(`进程 #${processId} 错误: ${error.message}`);

        // 清除所有定时器
        this._clearEntryTimers(entry);

        // 从活动进程列表移除
        this.processes.delete(processId);

        // 调用错误回调
        if (entry.onError) {
          try {
            entry.onError(error);
          } catch (callbackError) {
            Logger.error(`进程 #${processId} 错误回调失败: ${callbackError.message}`);
          }
        }
      });

      return childProcess;
    } catch (error) {
      Logger.error(`生成进程失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 杀死指定进程
   * @param {number} processId - 进程 ID
   * @param {string} signal - 信号
   * @returns {boolean} - 是否成功
   */
  kill(processId, signal = 'SIGTERM') {
    const entry = this.processes.get(processId);

    if (!entry) {
      Logger.debug(`进程 #${processId} 不存在或已完成`);
      return false;
    }

    if (entry.killed) {
      Logger.debug(`进程 #${processId} 已被标记为 killed`);
      return false;
    }

    try {
      Logger.debug(`杀死进程 #${processId} (信号: ${signal})`);
      entry.process.kill(signal);
      entry.killed = true;
      this.stats.totalKilled++;

      // 清除所有定时器
      this._clearEntryTimers(entry);

      return true;
    } catch (error) {
      Logger.error(`杀死进程 #${processId} 失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 清理进程条目的所有定时器
   * @param {Object} entry - 进程条目
   * @private
   */
  _clearEntryTimers(entry) {
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    if (entry.sigkillTimer) {
      clearTimeout(entry.sigkillTimer);
      entry.sigkillTimer = null;
    }
  }

  /**
   * 杀死所有活动进程
   * @returns {Promise<number>} - 杀死的进程数量
   */
  async killAll() {
    const processIds = Array.from(this.processes.keys());
    let killedCount = 0;

    Logger.info(`准备杀死 ${processIds.length} 个活动进程`);

    // 首先尝试优雅终止 (SIGTERM)
    for (const processId of processIds) {
      if (this.kill(processId, 'SIGTERM')) {
        killedCount++;
      }
    }

    // 等待 5 秒
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 检查是否还有活动进程，如果有则强制终止 (SIGKILL)
    const remainingIds = Array.from(this.processes.keys());
    if (remainingIds.length > 0) {
      Logger.warn(`${remainingIds.length} 个进程未能优雅终止，使用 SIGKILL`);
      for (const processId of remainingIds) {
        this.kill(processId, 'SIGKILL');
      }
    }

    Logger.info(`已杀死 ${killedCount} 个进程`);
    return killedCount;
  }

  /**
   * 清理已完成进程的记录
   */
  cleanup() {
    const beforeSize = this.processes.size;
    const now = Date.now();

    // 移除超过 5 分钟的已完成进程记录
    for (const [processId, entry] of this.processes.entries()) {
      if (entry.killed || (now - entry.spawnTime) > 300000) {
        this.processes.delete(processId);
      }
    }

    const afterSize = this.processes.size;
    if (beforeSize !== afterSize) {
      Logger.debug(`进程记录清理: ${beforeSize} -> ${afterSize}`);
    }
  }

  /**
   * 获取活动进程数量
   * @returns {number}
   */
  getActiveCount() {
    return this.processes.size;
  }

  /**
   * 获取进程统计信息
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      active: this.processes.size,
    };
  }

  /**
   * 获取活动进程列表
   * @returns {Array<Object>}
   */
  getActiveProcesses() {
    const processes = [];
    for (const [processId, entry] of this.processes.entries()) {
      processes.push({
        id: processId,
        command: entry.command,
        args: entry.args,
        spawnTime: entry.spawnTime,
        duration: Date.now() - entry.spawnTime,
        timeout: entry.timeout,
        killed: entry.killed,
      });
    }
    return processes;
  }

  /**
   * 检查进程是否活动
   * @param {number} processId - 进程 ID
   * @returns {boolean}
   */
  isActive(processId) {
    return this.processes.has(processId);
  }

  /**
   * 按命令名称查找进程
   * @param {string} command - 命令名称
   * @returns {Array<number>}
   */
  findByCommand(command) {
    const ids = [];
    for (const [processId, entry] of this.processes.entries()) {
      if (entry.command === command) {
        ids.push(processId);
      }
    }
    return ids;
  }

  /**
   * 杀死指定命令的所有进程
   * @param {string} command - 命令名称
   * @returns {number} - 杀死的进程数量
   */
  killByCommand(command) {
    const ids = this.findByCommand(command);
    let count = 0;
    for (const processId of ids) {
      if (this.kill(processId)) {
        count++;
      }
    }
    return count;
  }
}

/**
 * 全局进程管理器单例
 */
let globalProcessManager = null;

/**
 * 获取全局进程管理器
 * @returns {ProcessManager}
 */
export function getGlobalProcessManager() {
  if (!globalProcessManager) {
    globalProcessManager = new ProcessManager();
    globalProcessManager.start();
  }
  return globalProcessManager;
}

/**
 * 便捷函数：生成并跟踪进程
 * @param {string} command - 命令
 * @param {Array<string>} args - 参数
 * @param {Object} options - 选项
 * @returns {ChildProcess}
 */
export function spawnTracked(command, args = [], options = {}) {
  const manager = getGlobalProcessManager();
  return manager.spawn(command, args, options);
}

/**
 * 便捷函数：杀死所有跟踪的进程
 * @returns {Promise<number>}
 */
export async function killAllTracked() {
  const manager = getGlobalProcessManager();
  return manager.killAll();
}

export default ProcessManager;
