/**
 * Transcript 监控器 - 监控 Claude Code 的 transcript.jsonl 文件
 * 当检测到新的 assistant 消息时发送到飞书
 * Author: CodePothunter
 * Version: 1.4.0 - 集成交互消息解析器
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import Logger from './utils/logger.js';
import { InteractionParser, InteractionType } from './monitor/interaction-parser.js';

/**
 * 持久化状态管理器
 * 同时保存已处理的 UUID 和文件读取位置
 */
class PersistedStateStore {
  constructor(storageFile = '/tmp/claude-feishu-state.json') {
    this.storageFile = storageFile;
    this.processedUuids = new Map(); // uuid -> timestamp
    this.filePositions = new Map(); // {sessionId}:{filePath} -> { position, lastSize, mtime, sessionId }
    this.uuidTtl = 3600000; // 1 小时 TTL
    this.dirty = false;
    this._loadFromFile();
    this._startFlushTimer();
  }

  /**
   * 生成 session-aware 的文件位置 key
   * @param {string} sessionId - session ID
   * @param {string} filePath - 文件路径
   * @returns {string} 格式化的 key
   */
  _makeFileKey(sessionId, filePath) {
    return `${sessionId || 'unknown'}:${filePath}`;
  }

  /**
   * 解析文件位置 key，返回 sessionId 和 filePath
   * @param {string} key - 文件位置 key
   * @returns {{sessionId: string, filePath: string}}
   */
  _parseFileKey(key) {
    const colonIndex = key.indexOf(':');
    if (colonIndex === -1) {
      // 兼容旧格式（没有 sessionId 前缀）
      return { sessionId: null, filePath: key };
    }
    return {
      sessionId: key.substring(0, colonIndex),
      filePath: key.substring(colonIndex + 1)
    };
  }

  _loadFromFile() {
    let fileExists = false;
    try {
      const data = fs.readFileSync(this.storageFile, 'utf-8');
      fileExists = true;
      const parsed = JSON.parse(data);
      const now = Date.now();

      // 加载 UUID
      if (parsed.uuids) {
        for (const [uuid, timestamp] of Object.entries(parsed.uuids)) {
          if (now - timestamp <= this.uuidTtl) {
            this.processedUuids.set(uuid, timestamp);
          }
        }
      }

      // 加载文件位置
      if (parsed.files) {
        for (const [fileKey, state] of Object.entries(parsed.files)) {
          // 解析 key（可能是新格式 {sessionId}:{filePath} 或旧格式 {filePath}）
          const { sessionId, filePath } = this._parseFileKey(fileKey);

          // 只加载仍然有效的文件状态（检查文件是否存在且未修改）
          try {
            const stats = fs.statSync(filePath);
            const savedMtime = state.mtime || 0;
            // 如果文件修改时间没变，说明内容没变，可以继续使用保存的位置
            if (Math.abs(stats.mtimeMs - savedMtime) < 1000) {
              this.filePositions.set(fileKey, {
                position: state.position || 0,
                lastSize: state.lastSize || 0,
                mtime: stats.mtimeMs,
                sessionId: state.sessionId || sessionId
              });
            }
          } catch (e) {
            // 文件不存在，跳过
          }
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        Logger.warn(`加载持久化状态失败: ${e.message}`);
      }
      // 文件不存在是正常情况（首次启动）
    }

    if (fileExists) {
      Logger.info(`📂 已加载持久化状态: ${this.processedUuids.size} 条 UUID, ${this.filePositions.size} 个文件位置`);
    } else {
      Logger.info(`📂 持久化状态文件不存在，首次启动或已清理`);
    }
  }

  _saveToFile() {
    if (!this.dirty) return;

    try {
      const obj = {
        uuids: {},
        files: {},
        version: 1
      };

      // 保存 UUID
      for (const [uuid, timestamp] of this.processedUuids.entries()) {
        obj.uuids[uuid] = timestamp;
      }

      // 保存文件位置
      for (const [fileKey, state] of this.filePositions.entries()) {
        obj.files[fileKey] = {
          position: state.position,
          lastSize: state.lastSize,
          mtime: state.mtime,
          sessionId: state.sessionId
        };
      }

      // 确保目录存在
      const dir = path.dirname(this.storageFile);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }

      // 原子写入
      const tmpFile = this.storageFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(obj), {
        mode: 0o600,
        encoding: 'utf-8'
      });
      fs.renameSync(tmpFile, this.storageFile);
      this.dirty = false;
      Logger.debug(`已保存持久化状态: ${this.processedUuids.size} UUID, ${this.filePositions.size} 文件`);
    } catch (e) {
      Logger.error(`保存持久化状态失败: ${e.message}`);
    }
  }

  _startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this._saveToFile();
    }, 60000); // 每分钟保存一次
  }

  // UUID 操作
  hasUuid(uuid) {
    const timestamp = this.processedUuids.get(uuid);
    if (!timestamp) return false;

    // 检查过期
    const now = Date.now();
    if (now - timestamp > this.uuidTtl) {
      this.processedUuids.delete(uuid);
      this.dirty = true;
      return false;
    }
    return true;
  }

  addUuid(uuid) {
    this.processedUuids.set(uuid, Date.now());
    this.dirty = true;

    // 限制大小，LRU 淘汰
    if (this.processedUuids.size > 10000) {
      const firstKey = this.processedUuids.keys().next().value;
      if (firstKey) {
        this.processedUuids.delete(firstKey);
      }
    }
  }

  // 文件位置操作（session-aware）
  getFilePosition(sessionId, filePath) {
    const key = this._makeFileKey(sessionId, filePath);
    return this.filePositions.get(key);
  }

  setFilePosition(sessionId, filePath, position, lastSize, mtime) {
    const key = this._makeFileKey(sessionId, filePath);
    this.filePositions.set(key, { position, lastSize, mtime, sessionId });
    this.dirty = true;
  }

  removeFilePosition(sessionId, filePath) {
    const key = this._makeFileKey(sessionId, filePath);
    if (this.filePositions.has(key)) {
      this.filePositions.delete(key);
      this.dirty = true;
    }
  }

  /**
   * 清理指定 session 的所有文件位置
   * @param {string} sessionId - 要清理的 session ID
   */
  clearSessionFiles(sessionId) {
    if (!sessionId) return;

    const beforeSize = this.filePositions.size;
    const prefix = `${sessionId}:`;

    for (const key of this.filePositions.keys()) {
      if (key.startsWith(prefix)) {
        this.filePositions.delete(key);
        this.dirty = true;
      }
    }

    const afterSize = this.filePositions.size;
    if (beforeSize !== afterSize) {
      Logger.debug(`清理 session ${sessionId} 的文件位置: ${beforeSize} -> ${afterSize}`);
    }
  }

  clear() {
    this.processedUuids.clear();
    this.filePositions.clear();
    this.dirty = true;
  }

  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this._saveToFile();
  }
}

/**
 * Transcript 监控器类
 */
export class TranscriptMonitor {
  /**
   * @param {Object} options - 配置选项
   */
  constructor(options = {}) {
    this.projectPath = options.projectPath || process.cwd();
    this.messenger = options.messenger;
    this.checkInterval = options.checkInterval || 1000; // 1000ms - 降低监控频率以减少内存分配

    // 初始化持久化状态存储（UUID + 文件位置）
    this.stateStore = new PersistedStateStore(options.stateStorageFile);

    // Claude Code 项目路径
    // Claude Code 将绝对路径 /home/ubuntu/server 转换为 -home-ubuntu-server
    this.claudeProjectsPath = path.join(process.env.HOME || '', '.claude', 'projects');

    // 将项目路径转换为 Claude Code 的格式
    // /home/ubuntu/server -> -home-ubuntu-server
    let projectName = this.projectPath;
    // 确保是绝对路径
    if (!projectName.startsWith('/')) {
      projectName = path.resolve(projectName);
    }
    // 将所有 / 替换为 -
    projectName = projectName.replace(/\//g, '-');
    // 添加 - 前缀（如果还没有）
    if (!projectName.startsWith('-')) {
      projectName = '-' + projectName;
    }

    this.currentProject = path.join(this.claudeProjectsPath, projectName);

    Logger.transcript(`监控项目: ${this.currentProject}`);

    // 当前监控的文件位置（改为支持多文件）
    this.watchedFile = null;
    this.filePosition = 0;

    // 多文件监控：Map<filePath, { position: number, lastSize: number }>
    this.watchedFiles = new Map();

    // 使用 Map 实现 LRU 缓存（基于插入顺序）
    // Map<uuid, timestamp> - 保持插入顺序，用于真正的 LRU 淘汰
    this.processedMessages = new Map();
    this.maxProcessedMessages = 1000; // 最大缓存消息数

    // 定期清理已处理消息（每5分钟清理一次过期消息）
    this.processedMessagesTTL = 3600000; // 1小时 TTL
    this.lastCleanupTime = Date.now();

    // 当前 session ID（用于定位 subagents 目录）
    this.currentSessionId = null;

    // 当前 tmux 会话名称（用于获取工作目录）
    this.tmuxSessionName = options.tmuxSessionName || null;
    this.lastProjectPathCheck = 0;
    this.projectPathCheckInterval = 5000; // 每 5 秒检查一次项目路径变化

    // 定时器
    this.intervalId = null;

    // 是否正在运行
    this.isRunning = false;

    // 并发保护：防止同时执行多个 checkAndProcess
    this.isProcessing = false;

    // 重置时记录上一个 session ID，用于防止在 reset 后处理旧 session 的消息
    this.lastProcessedSessionId = null;
    this.waitingForNewSession = false;

    // Session 检测：定期强制刷新 session ID，用于检测 session 切换
    this.lastSessionCheckTime = null;
    this.sessionCheckInterval = 10000; // 每 10 秒强制刷新一次 session ID

    // Tmux commander（用于获取终端内容）
    this.tmuxCommander = options.tmuxCommander || null;

    // Plan Mode 检测状态
    this.lastPlanModeCheck = 0;
    this.planModeCheckInterval = 5000; // 每 5 秒检查一次 Plan Mode
    this.lastNotifiedPlanModeContent = null; // 上次通知的 Plan Mode 内容哈希
    this.lastPlanModeNotifyTime = null; // 上次通知的时间戳

    // 初始化交互消息解析器
    this.interactionParser = new InteractionParser();

    // 交互消息回调（用于发送通知）
    this.onInteraction = null;
  }

  /**
   * 设置交互消息回调
   * @param {Function} callback - 交互消息回调函数
   */
  setInteractionCallback(callback) {
    this.onInteraction = callback;
    Logger.transcript('已设置交互消息回调');
  }

  /**
   * 设置消息发送器
   * @param {Object} messenger - 消息发送器实例
   */
  setMessenger(messenger) {
    this.messenger = messenger;
  }

  /**
   * 设置 tmux commander（用于获取终端内容）
   * @param {Object} tmuxCommander - tmux 命令执行器实例
   */
  setTmuxCommander(tmuxCommander) {
    this.tmuxCommander = tmuxCommander;
    Logger.transcript('已设置 Tmux Commander');
  }

  /**
   * 获取当前 session ID
   * 通过查找最新的 .jsonl 文件或 session 目录来确定
   * @param {boolean} forceRefresh - 是否强制刷新缓存
   * @returns {string|null} session ID 或 null
   */
  getCurrentSessionId(forceRefresh = false) {
    if (this.currentSessionId && !forceRefresh) {
      Logger.debug(`使用缓存的 Session ID: ${this.currentSessionId}`);
      return this.currentSessionId;
    }

    try {
      const projectDir = this.currentProject;
      Logger.debug(`正在扫描项目目录: ${projectDir}`);

      if (!fs.existsSync(projectDir)) {
        Logger.debug(`项目目录不存在: ${projectDir}`);
        return null;
      }

      // 收集所有候选 session（目录 + .jsonl 文件）
      const candidates = [];

      // 1. 查找所有 session 目录
      const dirs = fs.readdirSync(projectDir).filter(f => {
        const dirPath = path.join(projectDir, f);
        return fs.statSync(dirPath).isDirectory();
      });
      for (const d of dirs) {
        candidates.push({
          id: d,
          mtime: fs.statSync(path.join(projectDir, d)).mtime.getTime(),
          type: 'dir'
        });
      }

      // 2. 查找所有 .jsonl 文件（格式: {uuid}.jsonl）
      const files = fs.readdirSync(projectDir).filter(f => {
        return f.endsWith('.jsonl') &&
               /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(f);
      });
      for (const f of files) {
        // 从文件名提取 session ID（去掉 .jsonl 后缀）
        const sessionId = f.replace(/\.jsonl$/, '');
        const mtime = fs.statSync(path.join(projectDir, f)).mtime.getTime();

        // 如果已经存在同名目录，更新其 mtime（取最大值）
        const existing = candidates.find(c => c.id === sessionId);
        if (existing) {
          existing.mtime = Math.max(existing.mtime, mtime);
        } else {
          candidates.push({
            id: sessionId,
            mtime: mtime,
            type: 'file'
          });
        }
      }

      // 按 mtime 降序排序，获取最新的 session
      candidates.sort((a, b) => b.mtime - a.mtime);

      Logger.debug(`找到 ${candidates.length} 个 session 候选`);

      if (candidates.length > 0) {
        const newSessionId = candidates[0].id;
        // 检测 session 是否变化
        if (this.currentSessionId !== newSessionId) {
          if (this.currentSessionId) {
            Logger.transcript(`Session 变化: ${this.currentSessionId} -> ${newSessionId}`);
          } else {
            Logger.transcript(`当前 Session ID: ${newSessionId}`);
          }

          // 检查是否是从 reset 后等待的新 session
          if (this.waitingForNewSession && newSessionId !== this.lastProcessedSessionId) {
            Logger.transcript(`检测到新 session: ${newSessionId}，结束等待状态`);
            this.waitingForNewSession = false;
            this.lastProcessedSessionId = null;
          }

          // Session 变化时清理旧的监控文件和持久化状态
          const oldSessionId = this.currentSessionId;
          this.watchedFiles.clear();

          // 清理持久化存储中的旧 session 文件位置
          if (oldSessionId && this.stateStore) {
            this.stateStore.clearSessionFiles(oldSessionId);
          }
        }
        this.currentSessionId = newSessionId;
        return this.currentSessionId;
      }

      Logger.debug(`没有找到任何 session`);
      return null;
    } catch (error) {
      Logger.error(`获取 session ID 失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 重置监控（用于 reset 后重新检测 session）
   */
  reset() {
    Logger.transcript('重置 Transcript 监控');
    // 记录当前（即将成为旧的）session ID
    this.lastProcessedSessionId = this.currentSessionId;
    this.currentSessionId = null;
    this.watchedFiles.clear();
    this.processedMessages.clear();
    // 清理持久化状态
    if (this.stateStore) {
      this.stateStore.clear();
    }
    // 设置标志：正在等待新 session
    this.waitingForNewSession = true;
    Logger.transcript(`记录上一 session: ${this.lastProcessedSessionId || 'none'}，等待新 session 创建`);
  }

  /**
   * 获取 tmux 会话的当前工作目录
   * @param {string} sessionName - tmux 会话名称
   * @returns {Promise<string|null>} 工作目录路径或 null
   */
  getTmuxSessionWorkingDir(sessionName) {
    if (!sessionName) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const proc = spawn('tmux', ['display-message', '-p', '-t', sessionName, '#{pane_current_path}'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          Logger.debug(`获取 tmux 会话 ${sessionName} 工作目录失败: ${stderr || 'exit code ' + code}`);
          resolve(null);
        }
      });

      // 2 秒超时
      setTimeout(() => {
        proc.kill();
        resolve(null);
      }, 2000);
    });
  }

  /**
   * 更新项目路径（用于切换 tmux session 时）
   * @param {string} newProjectPath - 新的项目路径
   */
  updateProjectPath(newProjectPath) {
    if (!newProjectPath || newProjectPath === this.projectPath) {
      return;
    }

    Logger.transcript(`更新项目路径: ${this.projectPath} -> ${newProjectPath}`);

    // 转换为 Claude Code 的项目目录格式
    let projectName = newProjectPath;
    // 确保是绝对路径
    if (!projectName.startsWith('/')) {
      projectName = path.resolve(projectName);
    }
    // 将所有 / 替换为 -
    projectName = projectName.replace(/\//g, '-');
    // 添加 - 前缀（如果还没有）
    if (!projectName.startsWith('-')) {
      projectName = '-' + projectName;
    }

    const newProjectDir = path.join(this.claudeProjectsPath, projectName);

    // 更新项目路径
    this.projectPath = newProjectPath;
    this.currentProject = newProjectDir;

    // 清理旧状态
    this.currentSessionId = null;
    this.watchedFiles.clear();
    this._lastLoggedSessionId = null;

    Logger.transcript(`Transcript 监控已更新到新项目: ${newProjectDir}`);
  }

  /**
   * 设置 tmux 会话名称（用于切换会话时）
   * @param {string} sessionName - tmux 会话名称
   */
  setTmuxSession(sessionName) {
    if (this.tmuxSessionName === sessionName) {
      return;
    }

    Logger.transcript(`切换 tmux 会话: ${this.tmuxSessionName || 'none'} -> ${sessionName}`);
    this.tmuxSessionName = sessionName;
    // 立即触发项目路径检查
    this.lastProjectPathCheck = 0;
  }

  /**
   * 获取所有需要监控的 transcript 文件（包括 subagents）
   * 主进程文件: {project}/{sessionId}.jsonl
   * Subagents 文件: {project}/{sessionId}/subagents/agent-xxx.jsonl
   * @returns {Array<string>} 文件路径数组
   */
  getAllTranscriptFiles() {
    const files = [];

    try {
      const sessionId = this.getCurrentSessionId();
      if (!sessionId) {
        Logger.transcript(`[Session ID: N/A] 未找到 session，无法获取文件列表`);
        return files;
      }

      // 主 transcript 文件: {project}/{sessionId}.jsonl
      const mainTranscript = path.join(this.currentProject, `${sessionId}.jsonl`);
      if (fs.existsSync(mainTranscript)) {
        files.push(mainTranscript);
      }

      // session 目录（用于存放 subagents）
      const sessionDir = path.join(this.currentProject, sessionId);

      // subagents 目录下的所有 transcript.jsonl 文件（新格式）
      const subagentsDir = path.join(sessionDir, 'subagents');
      if (fs.existsSync(subagentsDir)) {
        // 新格式: subagents/agent-xxx.jsonl
        const agentFiles = fs.readdirSync(subagentsDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => path.join(subagentsDir, f));

        for (const filePath of agentFiles) {
          if (fs.existsSync(filePath)) {
            files.push(filePath);
          }
        }

        // 只在文件数量变化时打印
        const fileCountKey = `subagent-${agentFiles.length}`;
        if (agentFiles.length > 0 && this._lastFileCountKey !== fileCountKey) {
          Logger.transcript(`监控 ${agentFiles.length} 个 subagent 文件`);
          this._lastFileCountKey = fileCountKey;
        }
      }

    } catch (error) {
      Logger.error(`获取 transcript 文件列表失败: ${error.message}`);
    }

    return files;
  }

  /**
   * 获取最新的 transcript 文件（保留用于兼容）
   * @returns {string|null} 文件路径或 null
   */
  getLatestTranscriptFile() {
    try {
      const projectDir = this.currentProject;
      if (!fs.existsSync(projectDir)) {
        return null;
      }

      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: path.join(projectDir, f),
          mtime: fs.statSync(path.join(projectDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) {
        return null;
      }

      // 返回最新修改的文件（当前活动的 session）
      return files[0].path;
    } catch (error) {
      Logger.error(`获取 transcript 文件失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 读取文件新增的内容（使用固定大小 buffer，避免大内存分配）
   * @param {string} filePath - 文件路径
   * @param {number} fromPosition - 起始位置
   * @returns {Array<string>} 新增的行
   */
  readNewLines(filePath, fromPosition) {
    try {
      const stats = fs.statSync(filePath);
      const currentSize = stats.size;

      if (fromPosition >= currentSize) {
        return [];
      }

      // 使用固定的 8KB buffer，而不是根据文件大小分配
      const CHUNK_SIZE = 8192; // 8KB 固定 buffer
      const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      const fd = fs.openSync(filePath, 'r');

      const lines = [];
      let remaining = currentSize - fromPosition;
      let currentPosition = fromPosition;
      let partialLine = ''; // 保存跨 chunk 的不完整行

      while (remaining > 0) {
        const readSize = Math.min(CHUNK_SIZE, remaining);
        const bytesRead = fs.readSync(fd, buffer, 0, readSize, currentPosition);

        if (bytesRead === 0) break;

        // 将读取的内容转换为字符串并处理
        const chunk = buffer.toString('utf-8', 0, bytesRead);
        const fullChunk = partialLine + chunk;
        const chunkLines = fullChunk.split('\n');

        // 保留最后一个可能不完整的行
        partialLine = chunkLines.pop() || '';

        // 添加完整的行
        for (const line of chunkLines) {
          if (line.trim().length > 0) {
            lines.push(line);
          }
        }

        currentPosition += bytesRead;
        remaining -= bytesRead;
      }

      // 处理最后剩余的部分（如果有）
      if (partialLine.trim().length > 0) {
        lines.push(partialLine);
      }

      fs.closeSync(fd);

      return lines;
    } catch (error) {
      Logger.error(`读取文件失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 检查消息是否包含文本内容
   * @param {Object} message - 消息对象
   * @returns {boolean}
   */
  hasTextContent(message) {
    if (!message || !message.content) {
      return false;
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      return false;
    }

    // 查找文本类型的内容
    return content.some(item =>
      item.type === 'text' &&
      item.text &&
      item.text.trim().length > 0
    );
  }

  /**
   * 提取消息的文本内容
   * @param {Object} message - 消息对象
   * @returns {string}
   */
  extractTextContent(message) {
    if (!message || !message.content) {
      return '';
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('\n');
  }

  /**
   * 检查是否是新的 assistant 消息
   * @param {Object} data - JSON 数据
   * @returns {boolean}
   */
  isNewAssistantMessage(data) {
    return (
      data.type === 'assistant' &&
      data.message &&
      data.message.role === 'assistant' &&
      data.uuid &&
      !this.processedMessages.has(data.uuid) &&
      !this.stateStore.hasUuid(data.uuid)  // 检查持久化存储
    );
  }

  /**
   * 标记消息为已处理（LRU 插入 + 持久化）
   * @param {string} uuid - 消息 UUID
   */
  markMessageProcessed(uuid) {
    // 内存中记录（用于快速检查）
    // 删除后重新插入以更新为最新（LRU 策略）
    if (this.processedMessages.has(uuid)) {
      this.processedMessages.delete(uuid);
    }
    this.processedMessages.set(uuid, Date.now());

    // 持久化到文件
    this.stateStore.addUuid(uuid);

    // 限制大小，删除最旧的条目（Map 保持插入顺序）
    if (this.processedMessages.size > this.maxProcessedMessages) {
      const firstKey = this.processedMessages.keys().next().value;
      if (firstKey) {
        this.processedMessages.delete(firstKey);
      }
    }
  }

  /**
   * 清理过期的已处理消息
   */
  cleanupProcessedMessages() {
    const now = Date.now();
    const beforeSize = this.processedMessages.size;

    // 清理超过 TTL 的条目
    for (const [uuid, timestamp] of this.processedMessages.entries()) {
      if (now - timestamp > this.processedMessagesTTL) {
        this.processedMessages.delete(uuid);
      }
    }

    const afterSize = this.processedMessages.size;
    if (beforeSize !== afterSize) {
      Logger.transcript(`清理过期消息: ${beforeSize} -> ${afterSize}`);
    }

    this.lastCleanupTime = now;
  }

  /**
   * 发送消息到飞书
   * @param {string} text - 消息文本
   */
  async sendToFeishu(text) {
    if (!this.messenger) {
      Logger.warn('Messenger 未设置，无法发送消息');
      return;
    }

    // 飞书消息长度限制（保守估计，实际API限制约50KB）
    const MAX_SINGLE_MESSAGE = 15000;
    const SPLIT_THRESHOLD = 12000;

    try {
      if (text.length <= SPLIT_THRESHOLD) {
        // 短消息直接发送
        await this.messenger.sendText(text);
        // Logger.feishu('Transcript 消息已发送'); // messenger 已打印，不再重复
      } else {
        // 长消息分片发送
        const chunks = this.splitMessage(text, MAX_SINGLE_MESSAGE);
        Logger.feishu(`消息过长 (${text.length} 字符)，分 ${chunks.length} 片发送`);

        for (let i = 0; i < chunks.length; i++) {
          const prefix = chunks.length > 1 ? `\`[${i + 1}/${chunks.length}]\`\n\n` : '';
          await this.messenger.sendText(prefix + chunks[i]);
          // 分片之间添加小延迟，避免触发API限流
          if (i < chunks.length - 1) {
            await this.sleep(300);
          }
        }
        // Logger.feishu(`Transcript 消息已发送 (${chunks.length} 片)`); // messenger 已打印，不再重复
      }
    } catch (error) {
      Logger.error(`发送消息失败: ${error.message}`);
    }
  }

  /**
   * 处理交互消息（AskUserQuestion, ExitPlanMode 等）
   * @param {Object} interaction - 交互消息对象
   */
  async handleInteraction(interaction) {
    try {
      if (interaction.type === InteractionType.ASK_USER_QUESTION) {
        await this.handleAskUserQuestion(interaction);
      } else if (interaction.type === InteractionType.EXIT_PLAN_MODE) {
        await this.handleExitPlanMode(interaction);
      }
      // 未来可扩展其他交互类型
    } catch (error) {
      Logger.error(`处理交互消息失败: ${error.message}`);
    }
  }

  /**
   * 处理 AskUserQuestion 交互
   * @param {Object} interaction - AskUserQuestion 交互数据
   */
  async handleAskUserQuestion(interaction) {
    const { question, uuid } = interaction;

    if (!this.messenger) {
      Logger.warn('Messenger 未设置，无法发送交互消息');
      return;
    }

    // 检查 messenger 是否有 sendAskUserQuestion 方法
    if (typeof this.messenger.sendAskUserQuestion === 'function') {
      await this.messenger.sendAskUserQuestion(question);
      Logger.transcript(`已发送 AskUserQuestion: ${question.header || question.text.substring(0, 30)}`);
    } else {
      // 降级处理：发送格式化文本
      let message = `❓ **Claude Code 需要您回答问题**\n\n`;

      if (question.header) {
        message += `**${question.header}**\n\n`;
      }

      message += `${question.text}\n\n`;

      if (question.options && question.options.length > 0) {
        message += '**请选择：**\n\n';
        for (let i = 0; i < question.options.length; i++) {
          const opt = question.options[i];
          message += `${i + 1}. ${opt.label}`;
          if (opt.description) {
            message += `\n   └─ ${opt.description}`;
          }
          message += '\n';
        }
        message += `\n💡 回复数字 ${question.multiSelect ? '（可多选，用逗号分隔）' : '选择'}确认`;
      }

      await this.messenger.sendText(message);
      Logger.transcript(`已发送 AskUserQuestion (降级格式): ${question.header || question.text.substring(0, 30)}`);
    }

    // 如果有回调，也通知调用方
    if (this.onInteraction) {
      try {
        await this.onInteraction(interaction);
      } catch (error) {
        Logger.error(`交互回调执行失败: ${error.message}`);
      }
    }
  }

  /**
   * 处理 ExitPlanMode 交互（Plan Mode 完成确认）
   * @param {Object} interaction - ExitPlanMode 交互数据
   */
  async handleExitPlanMode(interaction) {
    const { question, planFilePath } = interaction;

    if (!this.messenger) {
      Logger.warn('Messenger 未设置，无法发送交互消息');
      return;
    }

    let planContent = null;

    // 尝试读取计划文件内容
    if (planFilePath) {
      try {
        // 展开波浪号路径
        let fullPath = planFilePath;
        if (fullPath.startsWith('~/')) {
          const homeDir = process.env.HOME || '/home/ubuntu';
          fullPath = path.join(homeDir, fullPath.substring(2));
        }

        // 检查文件是否存在
        if (fs.existsSync(fullPath)) {
          planContent = fs.readFileSync(fullPath, 'utf-8');
          Logger.transcript(`已读取计划文件: ${fullPath} (${planContent.length} 字符)`);
        } else {
          Logger.warn(`计划文件不存在: ${fullPath}`);
        }
      } catch (error) {
        Logger.error(`读取计划文件失败: ${error.message}`);
      }
    }

    // 构建消息
    let message = `📋 **${question.header}**\n\n`;

    if (planContent) {
      // 添加计划文件内容（使用 Markdown 格式）
      message += `**📄 计划内容** (\`${planFilePath}\`):\n\n`;

      // 限制计划内容长度，避免消息过长
      const maxPlanLength = 5000;
      if (planContent.length > maxPlanLength) {
        planContent = planContent.slice(0, maxPlanLength) + `\n\n... (计划过长，已截断，共 ${planContent.length} 字符)`;
      }

      message += `${planContent}\n\n`;
    } else if (planFilePath) {
      message += `📄 计划文件: \`${planFilePath}\`\n\n`;
    }

    message += `**请选择下一步操作：**\n\n`;
    if (question.options && question.options.length > 0) {
      for (const opt of question.options) {
        message += `${opt.num}. ${opt.label}\n`;
      }
    }
    message += `\n💡 回复数字选择操作`;

    await this.messenger.sendText(message);
    Logger.transcript(`已发送 ExitPlanMode: ${planFilePath || '无文件路径'} (${planContent ? planContent.length : 0} 字符)`);

    // 如果有回调，也通知调用方
    if (this.onInteraction) {
      try {
        await this.onInteraction(interaction);
      } catch (error) {
        Logger.error(`交互回调执行失败: ${error.message}`);
      }
    }
  }

  /**
   * 分割消息为多个片段
   * @param {string} text - 原始消息
   * @param {number} maxLength - 每片最大长度
   * @returns {string[]} 消息片段数组
   */
  splitMessage(text, maxLength) {
    const chunks = [];

    // 尝试在合适的位置分割（段落、换行、句子）
    if (text.length <= maxLength) {
      return [text];
    }

    // 按段落分割
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';

    for (const para of paragraphs) {
      const testChunk = currentChunk + (currentChunk ? '\n\n' : '') + para;

      if (testChunk.length <= maxLength) {
        currentChunk = testChunk;
      } else {
        // 当前段落无法加入，先保存已有内容
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        // 如果单个段落超过限制，按行分割
        if (para.length > maxLength) {
          const lines = para.split('\n');
          let lineChunk = '';

          for (const line of lines) {
            const testLine = lineChunk + (lineChunk ? '\n' : '') + line;

            if (testLine.length <= maxLength) {
              lineChunk = testLine;
            } else {
              if (lineChunk) {
                chunks.push(lineChunk);
              }
              // 单行过长，强制分割
              if (line.length > maxLength) {
                for (let i = 0; i < line.length; i += maxLength) {
                  chunks.push(line.slice(i, i + maxLength));
                }
                lineChunk = '';
              } else {
                lineChunk = line;
              }
            }
          }
          currentChunk = lineChunk;
        } else {
          currentChunk = para;
        }
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks.length > 0 ? chunks : [text.slice(0, maxLength)];
  }

  /**
   * 延迟函数
   * @param {number} ms - 延迟毫秒数
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 检查并处理新的消息
   */
  async checkAndProcess() {
    // 并发保护：如果正在处理，跳过本次检查
    if (this.isProcessing) {
      Logger.debug('Transcript 监控正在处理中，跳过本次检查');
      return;
    }

    this.isProcessing = true;

    // 定期清理过期消息（每5分钟）
    const now = Date.now();
    if (now - this.lastCleanupTime > 300000) {
      this.cleanupProcessedMessages();
    }

    // 内存监控（每 10 秒检查一次）
    if (now - this.lastMemoryCheck > this.memoryCheckInterval) {
      const mem = process.memoryUsage();
      const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);

      if (mem.heapUsed > this.heapThreshold) {
        Logger.warn(`内存使用过高: ${heapUsedMB}MB (heapUsed: ${mem.heapUsed}, heapTotal: ${mem.heapTotal})`);

        // 清理已处理消息缓存
        const beforeSize = this.processedMessages.size;
        this.processedMessages.clear();
        Logger.transcript(`已清理消息缓存: ${beforeSize} 条`);

        // 如果有全局 GC，触发垃圾回收
        if (global.gc) {
          global.gc();
          const memAfter = process.memoryUsage();
          const heapAfterMB = Math.round(memAfter.heapUsed / 1024 / 1024);
          Logger.transcript(`GC 后内存: ${heapAfterMB}MB`);
        }
      }

      this.lastMemoryCheck = now;
    }

    // 动态更新项目路径（根据 tmux 会话的工作目录）
    if (this.tmuxSessionName && (now - this.lastProjectPathCheck > this.projectPathCheckInterval)) {
      this.lastProjectPathCheck = now;
      const workingDir = await this.getTmuxSessionWorkingDir(this.tmuxSessionName);
      if (workingDir && workingDir !== this.projectPath) {
        Logger.transcript(`检测到项目路径变化: ${this.projectPath} -> ${workingDir}`);
        this.updateProjectPath(workingDir);
        // 清理旧的监控状态，因为项目变了
        this.watchedFiles.clear();
        this.currentSessionId = null;
      }
    }

    // 打印当前 session ID（仅第一次或 session 变化时）
    // 定期强制刷新 session ID，以检测 session 切换（即使没有通过 /reset 命令）
    const sessionCheckNow = Date.now();
    const shouldForceRefresh = this.waitingForNewSession ||
                               !this.lastSessionCheckTime ||
                               (sessionCheckNow - this.lastSessionCheckTime > this.sessionCheckInterval);
    const currentSessionId = this.getCurrentSessionId(shouldForceRefresh);
    if (shouldForceRefresh) {
      this.lastSessionCheckTime = sessionCheckNow;
    }
    if (currentSessionId !== this._lastLoggedSessionId) {
      Logger.transcript(`[Session ID: ${currentSessionId || 'N/A'}] 开始检查 transcript`);
      this._lastLoggedSessionId = currentSessionId;
    }

    // 如果正在等待新 session，且当前还是旧 session，则跳过处理
    if (this.waitingForNewSession) {
      if (currentSessionId === this.lastProcessedSessionId) {
        // 改为 debug 级别，避免日志刷屏
        Logger.debug(`等待新 session 创建，跳过旧 session: ${currentSessionId}`);
        this.isProcessing = false;
        return;
      } else if (currentSessionId) {
        // 新 session 已创建
        Logger.transcript(`检测到新 session: ${currentSessionId}，结束等待状态`);
        this.waitingForNewSession = false;
        this.lastProcessedSessionId = null;
      }
    }

    // 检测 Plan Mode 完成确认（通过 tmux 终端内容）
    if (this.tmuxCommander && (now - this.lastPlanModeCheck > this.planModeCheckInterval)) {
      this.lastPlanModeCheck = now;
      await this.checkPlanMode();
    }

    try {
      // 获取所有需要监控的文件
      const allFiles = this.getAllTranscriptFiles();

      if (allFiles.length === 0) {
        return;
      }

      // 检测新增的文件
      for (const filePath of allFiles) {
        if (!this.watchedFiles.has(filePath)) {
          // 检查是否有持久化的位置（使用当前 session ID）
          const savedState = this.stateStore.getFilePosition(currentSessionId, filePath);
          if (savedState) {
            Logger.transcript(`恢复监控文件: ${path.basename(path.dirname(filePath))}/${path.basename(filePath)} (从位置 ${savedState.position})`);
            this.watchedFiles.set(filePath, savedState);
          } else {
            Logger.transcript(`新增监控文件: ${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`);
            this.watchedFiles.set(filePath, { position: 0, lastSize: 0 });
          }
        }
      }

      // 清理已不存在的文件（session 切换时）
      for (const filePath of this.watchedFiles.keys()) {
        if (!allFiles.includes(filePath)) {
          Logger.transcript(`移除监控文件: ${path.basename(filePath)}`);
          this.watchedFiles.delete(filePath);
        }
      }

      // 处理每个文件
      for (const filePath of allFiles) {
        await this.processFile(filePath);
      }

    } catch (error) {
      Logger.error(`检查 transcript 失败: ${error.message}`);
    } finally {
      // 释放处理锁
      this.isProcessing = false;
    }
  }

  /**
   * 判断消息是否应该发送给用户
   * 使用交互消息解析器进行更智能的过滤
   * @param {Object} data - 消息数据
   * @returns {{send: boolean, interaction: Object|null, pureText: boolean}}
   */
  shouldSendToUser(data) {
    // 使用交互解析器判断
    const result = this.interactionParser.shouldSendMessage(data);

    if (result.send) {
      if (result.interaction) {
        Logger.transcript(`检测到交互消息: ${result.interaction.type}`);
      } else if (result.pureText) {
        Logger.transcript('检测到纯文本消息');
      }
    } else {
      Logger.transcript('消息被过滤（tool_use、thinking 或内部指令）');
    }

    return result;
  }

  /**
   * 处理单个文件
   * @param {string} filePath - 文件路径
   */
  async processFile(filePath) {
    try {
      // 使用当前 session ID（从路径中解析作为备选）
      let fileSessionId = this.currentSessionId;
      if (!fileSessionId) {
        // 尝试从路径中解析 session ID（UUID 格式）
        const pathParts = filePath.split(path.sep);
        const uuidMatch = pathParts.find(p => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p));
        fileSessionId = uuidMatch || 'unknown';
      }

      const fileState = this.watchedFiles.get(filePath);
      if (!fileState) {
        fileState = { position: 0, lastSize: 0 };
        this.watchedFiles.set(filePath, fileState);
      }

      // 读取新增的行
      const newLines = this.readNewLines(filePath, fileState.position);

      if (newLines.length === 0) {
        return;
      }

      // 显示相对路径（从项目目录开始）
      const relativePath = filePath.substring(this.currentProject.length + 1);
      // 显示文件名（主进程显示 session.jsonl，subagent 显示 agent-xxx.jsonl）
      const fileName = path.basename(relativePath);
      const displayName = fileName === `${fileSessionId}.jsonl` ? '[主进程]' : `[${fileName}]`;
      Logger.transcript(`${displayName} 读取到 ${newLines.length} 行新内容`);

      // 处理每一行
      for (const line of newLines) {
        try {
          const data = JSON.parse(line);

          // 检查是否是新的 assistant 消息
          if (this.isNewAssistantMessage(data)) {
            // 使用 shouldSendToUser 判断是否应该发送
            const sendResult = this.shouldSendToUser(data);

            if (!sendResult.send) {
              // 标记为已处理但不发送（避免重复检查）
              this.markMessageProcessed(data.uuid);
              continue;
            }

            // 处理交互消息（优先处理）
            if (sendResult.interaction) {
              await this.handleInteraction(sendResult.interaction);
            }

            // 处理纯文本消息
            if (sendResult.pureText) {
              const text = this.interactionParser.extractText(data);
              if (text) {
                await this.sendToFeishu(text);
              }
            }

            // 标记为已处理
            this.markMessageProcessed(data.uuid);
          }
        } catch (parseError) {
          // 忽略 JSON 解析错误
        }
      }

      // 更新文件位置
      const stats = fs.statSync(filePath);
      fileState.position = stats.size;
      fileState.lastSize = stats.size;

      // 持久化文件位置（使用当前 session ID）
      this.stateStore.setFilePosition(fileSessionId, filePath, stats.size, stats.size, stats.mtimeMs);

    } catch (error) {
      Logger.error(`处理文件 ${filePath} 失败: ${error.message}`);
    }
  }

  /**
   * 启动监控
   */
  start() {
    if (this.isRunning) {
      Logger.warn('Transcript 监控已在运行');
      return;
    }

    this.isRunning = true;
    Logger.transcript('启动 transcript 监控（支持 subagents）');

    // 检查能否找到 transcript 文件
    const sessionId = this.getCurrentSessionId();
    if (sessionId) {
      const mainTranscript = path.join(this.currentProject, `${sessionId}.jsonl`);
      const sessionDir = path.join(this.currentProject, sessionId);
      Logger.transcript(`[Session ID: ${sessionId}] 主文件: ${path.basename(mainTranscript)}`);

      // 统计 subagents 数量（新格式：agent-xxx.jsonl）
      const subagentsDir = path.join(sessionDir, 'subagents');
      if (fs.existsSync(subagentsDir)) {
        const agentCount = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl')).length;
        Logger.transcript(`发现 ${agentCount} 个 subagent 文件`);
      }
    } else {
      Logger.warn(`未找到 transcript 文件，项目路径: ${this.currentProject}`);
    }

    // 立即检查一次
    this.checkAndProcess();

    // 定时检查
    this.intervalId = setInterval(() => {
      this.checkAndProcess();
    }, this.checkInterval);
  }

  /**
   * 停止监控
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

    // 销毁持久化状态存储
    if (this.stateStore) {
      this.stateStore.destroy();
    }

    Logger.transcript('transcript 监控已停止');
  }

  /**
   * 检查 Plan Mode 完成确认状态
   * 通过 tmux 终端内容检测（不在 transcript.jsonl 中）
   */
  async checkPlanMode() {
    if (!this.tmuxCommander || !this.messenger) {
      return;
    }

    try {
      // 捕获 tmux 终端内容
      const tmuxContent = await this.tmuxCommander.capture(100);
      if (!tmuxContent || tmuxContent.trim().length === 0) {
        return;
      }

      // 使用 interactionParser 检测 Plan Mode
      const isPlanMode = this.interactionParser.isExitPlanMode(tmuxContent);

      if (isPlanMode) {
        // 检查内容是否与上次通知的相同（避免重复通知）
        const contentHash = this._hashPlanModeContent(tmuxContent);
        const now = Date.now();

        // 如果内容相同且上次通知时间在 5 分钟内，跳过
        if (contentHash === this.lastNotifiedPlanModeContent &&
            this.lastPlanModeNotifyTime &&
            (now - this.lastPlanModeNotifyTime) < 300000) {
          return;
        }

        // 解析 Plan Mode
        const interaction = this.interactionParser.parseExitPlanMode(tmuxContent);
        if (interaction) {
          await this.handleInteraction(interaction);
          this.lastNotifiedPlanModeContent = contentHash;
          this.lastPlanModeNotifyTime = now;
          Logger.transcript(`已发送 Plan Mode 通知`);
        }
      } else {
        // 不在 Plan Mode 时，重置通知记录
        this.lastNotifiedPlanModeContent = null;
        this.lastPlanModeNotifyTime = null;
      }
    } catch (error) {
      Logger.error(`检查 Plan Mode 失败: ${error.message}`);
    }
  }

  /**
   * 生成 Plan Mode 内容的哈希值（用于去重）
   * @param {string} content - tmux 内容
   * @returns {string} - 哈希值
   */
  _hashPlanModeContent(content) {
    // 只哈�选项部分，忽略时间戳等变化内容
    const lines = content.split('\n');
    const optionLines = lines.filter(line => /^\s*❯\s*\d+\./.test(line) || /^\s*\d+\.\s+Yes/.test(line));
    return optionLines.join('|');
  }
}

export default TranscriptMonitor;
