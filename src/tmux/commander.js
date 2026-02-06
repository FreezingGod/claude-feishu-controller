/**
 * Tmux 命令执行器
 * Author: CodePothunter
 * Version: 1.1.0 - 添加重试和进程跟踪
 */

import { spawn } from 'child_process';
import TmuxSession from './session.js';
import Logger from '../utils/logger.js';
import { withRetry, RetryConfigs, RetryableErrors } from '../utils/retry.js';
import { getGlobalProcessManager } from '../utils/process-manager.js';

/**
 * Tmux 命令执行器类
 */
export class TmuxCommander {
  /**
   * @param {string} sessionName - tmux 会话名称
   */
  constructor(sessionName) {
    this.sessionName = sessionName;
    this.activeProcesses = new Map(); // 跟踪活动的 tmux 进程
  }

  /**
   * 更新会话名称
   * @param {string} sessionName - 新的会话名称
   */
  setSession(sessionName) {
    this.sessionName = sessionName;
    Logger.debug(`Commander 会话更新为: ${sessionName}`);
  }

  /**
   * 发送单个按键
   * @param {string} key - 按键名称
   * @returns {Promise<void>}
   */
  async sendKey(key) {
    Logger.debug(`发送按键: ${key}`);
    await TmuxSession.sendKeys(this.sessionName, key);
  }

  /**
   * 发送多个按键
   * @param {string[]} keys - 按键列表
   * @returns {Promise<void>}
   */
  async sendKeys(...keys) {
    Logger.debug(`发送按键: ${keys.join(' ')}`);
    await TmuxSession.sendKeys(this.sessionName, ...keys);
  }

  /**
   * 发送文本（使用 buffer 粘贴）
   * @param {string} text - 文本内容
   * @param {number} delay - 粘贴后延迟（毫秒）
   * @returns {Promise<void>}
   */
  async sendText(text, delay = 500) {
    Logger.debug(`发送文本: ${text.substring(0, 50)}...`);
    await TmuxSession.sendText(this.sessionName, text, delay);
  }

  /**
   * 发送命令（文本 + Enter）
   * @param {string} command - 命令内容
   * @returns {Promise<void>}
   */
  async sendCommand(command) {
    Logger.message(`发送命令: ${command}`);
    const delay = Math.max(500, command.length * 5);
    await this.sendText(command, delay);
    await this.sendKey('Enter');
  }

  /**
   * 捕获输出
   * @param {number} lines - 捕获行数
   * @returns {Promise<string>} - 捕获的内容
   */
  async capture(lines = 500) {
    const result = await TmuxSession.capturePane(this.sessionName, lines);
    if (result.error) {
      Logger.error(`捕获失败: ${result.message}`);
      return '';
    }
    return result.output || '';
  }

  /**
   * 执行 spawn 命令并跟踪进程
   * @param {string} command - 命令
   * @param {string[]} args - 参数
   * @param {Object} options - 选项
   * @returns {ChildProcess}
   */
  spawnTracked(command, args, options = {}) {
    const processManager = getGlobalProcessManager();
    return processManager.spawn(command, args, {
      timeout: options.timeout || 5000,
      ...options,
    });
  }

  /**
   * 执行命令并返回结果（带重试）
   * @param {string} command - 要执行的命令
   * @param {Object} options - 执行选项
   * @returns {Promise<{success: boolean, output?: string, error?: string}>}
   */
  async execute(command, options = {}) {
    const {
      waitTime = 2000,
      captureLines = 50,
      clearLine = true,
      retry = true,
    } = options;

    Logger.info(`执行命令: ${command}`);

    const executeInternal = async () => {
      try {
        // 清空当前行
        if (clearLine) {
          this.spawnTracked('tmux', ['send-keys', '-t', this.sessionName, 'C-u'], { timeout: 2000 });
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // 发送命令
        this.spawnTracked('tmux', ['send-keys', '-t', this.sessionName, command, 'Enter'], { timeout: 2000 });

        // 根据命令类型调整等待时间
        let actualWaitTime = waitTime;
        if (command.startsWith('vim') || command.startsWith('nano') || command.startsWith('vi')) {
          actualWaitTime = 100;
        } else if (command.startsWith('git ') || command.includes('test') || command.includes('build')) {
          actualWaitTime = 4000;
        } else if (command.includes('npm') || command.includes('yarn') || command.includes('install')) {
          actualWaitTime = 6000;
        } else if (command === 'ls' || command === 'pwd' || command === 'whoami') {
          actualWaitTime = 800;
        }

        await new Promise(resolve => setTimeout(resolve, actualWaitTime));

        // 多次尝试捕获输出
        let output = '';
        for (let i = 0; i < 3; i++) {
          const captureResult = await TmuxSession.capturePane(this.sessionName, captureLines);
          if (!captureResult.error && captureResult.output) {
            output = captureResult.output;
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        // 解析输出
        const parsed = this.parseCommandOutput(output, command);

        return {
          success: true,
          output: parsed,
        };
      } catch (error) {
        Logger.error(`命令执行失败: ${error.message}`);
        throw error;
      }
    };

    try {
      if (retry) {
        return await withRetry(executeInternal, RetryConfigs.command);
      } else {
        return await executeInternal();
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 解析命令输出
   * @param {string} output - 原始输出
   * @param {string} command - 执行的命令
   * @returns {string} - 解析后的输出
   */
  parseCommandOutput(output, command) {
    const lines = output.split('\n');

    // 从后往前找，找到最后的提示符之前的内容
    let resultLines = [];
    let foundPrompt = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];

      // 检测到提示符
      if (line.match(/^\s*(❯|>|\$|>>>|=>)\s*/) ||
          line.match(/ubuntu@.*:\$|root@.*:#|user@.*:/)) {
        foundPrompt = true;
        continue;
      }

      // 跳过空行
      if (line.trim() === '' && resultLines.length > 0) {
        continue;
      }

      // 收集结果行（倒序）
      if (foundPrompt || resultLines.length > 0) {
        resultLines.unshift(line);
      }
    }

    // 如果没找到提示符，就返回最后几行
    if (resultLines.length === 0) {
      resultLines = lines.slice(-10);
    }

    // 清理结果
    let result = resultLines.join('\n').trim();

    // 移除命令本身
    result = result.replace(new RegExp(`^.*\\$?${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm'), '');
    result = result.replace(new RegExp(`^.*${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm'), '');

    // 限制输出长度
    if (result.length > 2000) {
      result = result.slice(0, 2000) + '\n... (输出过长，已截断)';
    }

    if (!result) {
      result = '(命令已执行，但没有输出)';
    }

    return result;
  }

  /**
   * 发送中断信号（Ctrl+C）
   * @returns {Promise<void>}
   */
  async interrupt() {
    Logger.warn('发送中断信号 (Ctrl+C)');
    this.spawnTracked('tmux', ['send-keys', '-t', this.sessionName, 'C-c'], { timeout: 2000 });
  }

  /**
   * 发送 ESC 键
   * @returns {Promise<void>}
   */
  async sendEscape() {
    Logger.debug('发送 ESC 键');
    await this.sendKey('Escape');
  }

  /**
   * 确认操作（发送 Enter 或 y + Enter）
   * @param {string} key - 确认键类型 ('Enter' 或 'y')
   * @returns {Promise<void>}
   */
  async confirm(key) {
    Logger.debug(`确认操作: ${key}`);

    if (key === 'Enter') {
      await this.sendKey('Enter');
    } else {
      await this.sendKey(key);
      await new Promise(resolve => setTimeout(resolve, 50));
      await this.sendKey('Enter');
    }
  }

  /**
   * 取消操作（发送 Ctrl+C）
   * @returns {Promise<void>}
   */
  async cancel() {
    Logger.info('取消操作');
    await this.interrupt();
  }
}

export default TmuxCommander;
