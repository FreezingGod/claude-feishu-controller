/**
 * 会话管理器
 * Author: CodePothunter
 * Version: 1.2.0 - 自动检测并使用第一个可用 session
 */

import fs from 'fs';
import path from 'path';
import { config } from './config/index.js';
import { BufferManager } from './monitor/buffer.js';
import Logger from './utils/logger.js';
import { TmuxSession } from './tmux/session.js';

/**
 * 会话管理器类
 */
export class SessionManager {
  constructor() {
    this.currentSession = { value: '' };
    this.buffer = new BufferManager({
      maxSize: config.monitor.maxBufferLength,
      minSize: config.monitor.minBufferLength,
    });
    this.sessionSwitchLock = false;
    this.commandHistory = [];
    this.maxHistorySize = 100;
    this.sessionFile = config.session.file;

    // 加载上次的会话（同步，确保在构造函数完成时可用）
    this.loadLastSessionSync();
  }

  /**
   * 从文件加载上次使用的会话（同步，用于构造函数）
   */
  loadLastSessionSync() {
    try {
      const session = fs.readFileSync(this.sessionFile, 'utf-8');
      const trimmed = session.trim();
      if (trimmed) {
        this.currentSession.value = trimmed;
        Logger.debug(`加载上次会话: ${trimmed}`);
        return;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        Logger.warn(`读取 session 配置失败: ${e.message}`);
      }
      // 文件不存在是正常情况，留空等待自动检测
    }
    // 不再设置默认值，留空等待异步自动检测
  }

  /**
   * 异步初始化：自动检测并使用第一个可用会话
   * 需要在服务启动后调用
   */
  async autoSelectSession() {
    // 如果已经有会话，检查是否仍然存在
    const current = this.currentSession.value;
    if (current) {
      const exists = await TmuxSession.exists(current);
      if (exists) {
        Logger.info(`✅ 当前会话 ${current} 存在，继续使用`);
        return;
      } else {
        Logger.warn(`⚠️  当前会话 ${current} 不存在，将自动选择第一个可用会话`);
      }
    }

    // 自动选择第一个可用会话
    const result = await TmuxSession.list();
    Logger.debug(`TmuxSession.list() 返回: ${JSON.stringify(result)}`);

    if (result.error) {
      Logger.error(`获取 tmux 会话列表失败: ${result.error}`);
      this.currentSession.value = '';
      return;
    }

    if (result.sessions && result.sessions.length > 0) {
      this.currentSession.value = result.sessions[0];
      this.saveSync(result.sessions[0]);
      Logger.info(`🔄 自动选择第一个可用会话: ${result.sessions[0]}`);
    } else {
      Logger.warn(`⚠️  没有可用的 tmux 会话，请先创建或使用 /new 命令创建`);
      this.currentSession.value = '';
    }
  }

  /**
   * 从文件加载上次使用的会话（异步，保留用于兼容）
   */
  async loadLastSession() {
    try {
      const session = await fs.promises.readFile(this.sessionFile, 'utf-8');
      const trimmed = session.trim();
      if (trimmed) {
        this.currentSession.value = trimmed;
        Logger.debug(`加载上次会话: ${trimmed}`);
        return;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        Logger.warn(`读取 session 配置失败: ${e.message}`);
      }
      // 文件不存在是正常情况，使用默认值
    }
    this.currentSession.value = config.session.defaultName;
  }

  /**
   * 保存当前会话（异步，带原子写入和权限控制）
   * @param {string} session - 会话名称
   */
  async save(session) {
    try {
      const tmpFile = this.sessionFile + '.tmp';

      // 确保目录存在
      const dir = path.dirname(this.sessionFile);
      try {
        await fs.promises.mkdir(dir, { recursive: true });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }

      // 原子写入 + 权限控制
      await fs.promises.writeFile(tmpFile, session, {
        mode: 0o600,  // 仅所有者可读写
        encoding: 'utf-8'
      });
      await fs.promises.rename(tmpFile, this.sessionFile);

      Logger.debug(`保存会话: ${session}`);
    } catch (e) {
      Logger.warn(`保存 session 配置失败: ${e.message}`);
    }
  }

  /**
   * 同步保存（保持向后兼容）
   * @param {string} session - 会话名称
   */
  saveSync(session) {
    try {
      fs.writeFileSync(this.sessionFile, session, { mode: 0o600 });
      Logger.debug(`保存会话: ${session}`);
    } catch (e) {
      Logger.warn(`保存 session 配置失败: ${e.message}`);
    }
  }

  /**
   * 获取当前会话名称
   * @returns {string}
   */
  getCurrentSession() {
    return this.currentSession.value;
  }

  /**
   * 设置当前会话
   * @param {string} session - 会话名称
   */
  setCurrentSession(session) {
    this.currentSession.value = session;
  }

  /**
   * 获取会话状态（用于 ref）
   * @returns {Object}
   */
  getSessionRef() {
    return this.currentSession;
  }

  /**
   * 添加到命令历史
   * @param {string} command - 命令内容
   */
  addHistory(command) {
    this.commandHistory.push({
      command,
      timestamp: Date.now(),
    });

    // 限制历史大小
    if (this.commandHistory.length > this.maxHistorySize) {
      this.commandHistory = this.commandHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * 获取命令历史
   * @returns {string[]}
   */
  getHistory() {
    return this.commandHistory.map(h => h.command);
  }

  /**
   * 清空命令历史
   */
  clearHistory() {
    this.commandHistory = [];
    Logger.debug('命令历史已清空');
  }

  /**
   * 锁定会话切换
   */
  lockSwitch() {
    this.sessionSwitchLock = true;
  }

  /**
   * 解锁会话切换
   */
  unlockSwitch() {
    this.sessionSwitchLock = false;
  }

  /**
   * 检查是否锁定
   * @returns {boolean}
   */
  isSwitchLocked() {
    return this.sessionSwitchLock;
  }
}

export default SessionManager;
