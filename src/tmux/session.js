/**
 * Tmux 会话管理
 * Author: CodePothunter
 * Version: 1.0.0
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import Logger from '../utils/logger.js';

const execAsync = promisify(exec);

/**
 * 执行 tmux 命令并获取输出
 * @param {string[]} args - tmux 命令参数
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<{error: boolean, output?: string, message?: string}>}
 */
export function execTmuxCommand(args, timeout = 30000) {
  return new Promise((resolve) => {
    const tmux = spawn('tmux', args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // 超时处理
    const timer = setTimeout(() => {
      timedOut = true;
      tmux.kill('SIGKILL');
      resolve({ error: true, message: `Command timeout after ${timeout}ms` });
    }, timeout);

    tmux.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    tmux.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    tmux.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: true, message: `Failed to spawn tmux: ${err.message}` });
    });

    tmux.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) {
        resolve({ error: true, message: stderr || `Exit code: ${code}` });
      } else {
        resolve({ error: false, output: stdout.trim() });
      }
    });
  });
}

/**
 * Tmux 会话管理类
 */
export class TmuxSession {
  /**
   * 列出所有 tmux 会话
   * @returns {Promise<{sessions?: string[], error?: string}>}
   */
  static async list() {
    Logger.tmux('列出所有 tmux 会话');
    const result = await execTmuxCommand(['list-sessions', '-F', '#{session_name}']);

    if (result.error) {
      return { error: result.message };
    }

    if (!result.output) {
      return { sessions: [] };
    }

    const sessions = result.output.split('\n').filter(s => s);
    Logger.debug(`找到 ${sessions.length} 个会话: ${sessions.join(', ')}`);
    return { sessions };
  }

  /**
   * 创建新会话
   * @param {string} name - 会话名称
   * @param {string} workingDir - 工作目录（可选）
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  static async create(name, workingDir = null) {
    Logger.tmux(`创建新会话: ${name}${workingDir ? ` (目录: ${workingDir})` : ''}`);

    const args = ['new-session', '-d', '-s', name];
    if (workingDir) {
      args.push('-c', workingDir);
    }

    const result = await execTmuxCommand(args);

    if (result.error) {
      Logger.error(`创建会话失败: ${result.message}`);
      return { success: false, error: result.message };
    }

    Logger.success(`会话 ${name} 创建成功`);
    return { success: true };
  }

  /**
   * 杀掉会话
   * @param {string} name - 会话名称
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  static async kill(name) {
    Logger.tmux(`杀掉会话: ${name}`);
    const result = await execTmuxCommand(['kill-session', '-t', name]);

    if (result.error && !result.message.includes('session not found')) {
      Logger.error(`杀掉会话失败: ${result.message}`);
      return { success: false, error: result.message };
    }

    Logger.success(`会话 ${name} 已杀掉`);
    return { success: true };
  }

  /**
   * 检查会话是否存在
   * @param {string} name - 会话名称
   * @returns {Promise<boolean>}
   */
  static async exists(name) {
    const { sessions } = await this.list();
    return sessions ? sessions.includes(name) : false;
  }

  /**
   * 获取会话的工作目录
   * @param {string} sessionName - 会话名称
   * @returns {Promise<string|null>}
   */
  static async getWorkingDir(sessionName) {
    try {
      // 获取会话的第一个窗口的 pane PID
      const result = await execTmuxCommand([
        'list-panes', '-s', '-t', sessionName, '-F', '#{pane_pid}'
      ]);

      if (result.error || !result.output) {
        return null;
      }

      const pid = result.output.split('\n')[0];
      if (!pid || pid === '0') return null;

      // 通过 pid 获取工作目录
      const { stdout } = await execAsync(`pwdx ${pid}`);
      const match = stdout.match(/\/.*/);
      return match ? match[0].trim() : null;
    } catch (error) {
      Logger.debug(`获取工作目录失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 发送按键到会话
   * @param {string} sessionName - 会话名称
   * @param {string[]} keys - 按键列表
   * @returns {Promise<void>}
   */
  static async sendKeys(sessionName, ...keys) {
    for (const key of keys) {
      await execTmuxCommand(['send-keys', '-t', sessionName, key]);
    }
  }

  /**
   * 设置 buffer 内容
   * @param {string} sessionName - 会话名称
   * @param {string} content - buffer 内容
   * @returns {Promise<void>}
   */
  static async setBuffer(sessionName, content) {
    // 直接使用内容，不添加引号
    // tmux set-buffer 直接接受字符串参数，不需要 JSON.stringify
    await execTmuxCommand(['set-buffer', '-t', sessionName, content]);
  }

  /**
   * 粘贴 buffer
   * @param {string} sessionName - 会话名称
   * @returns {Promise<void>}
   */
  static async pasteBuffer(sessionName) {
    await execTmuxCommand(['paste-buffer', '-t', sessionName]);
  }

  /**
   * 捕获窗格内容
   * @param {string} sessionName - 会话名称
   * @param {number} lines - 捕获行数
   * @returns {Promise<{error?: boolean, output?: string, message?: string}>}
   */
  static async capturePane(sessionName, lines = 500) {
    return await execTmuxCommand([
      'capture-pane', '-p', '-t', sessionName, '-S', `-${lines}`
    ]);
  }

  /**
   * 发送文本到会话（使用 buffer 粘贴）
   * @param {string} sessionName - 会话名称
   * @param {string} text - 文本内容
   * @param {number} delay - 粘贴后延迟（毫秒）
   * @returns {Promise<void>}
   */
  static async sendText(sessionName, text, delay = 500) {
    await this.setBuffer(sessionName, text);
    await this.pasteBuffer(sessionName);
    // 等待粘贴完成
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * 切换到指定会话（保存状态）
   * @param {string} fromSession - 原会话
   * @param {string} toSession - 目标会话
   * @returns {Promise<void>}
   */
  static async switch(fromSession, toSession) {
    Logger.tmux(`切换会话: ${fromSession} -> ${toSession}`);
    // 不需要实际切换 tmux 会话，只是更新监控目标
  }
}

export default TmuxSession;
