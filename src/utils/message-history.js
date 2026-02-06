/**
 * 消息发送历史去重器
 * 用于记录已发送给飞书的消息，防止服务重启后重复发送
 * Author: CodePothunter
 * Version: 1.0.0
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Logger from './logger.js';

/**
 * 计算消息内容的哈希值
 * @param {string} content - 消息内容
 * @returns {string} - SHA256 哈希值
 */
function hashContent(content) {
  return crypto
    .createHash('sha256')
    .update(content, 'utf-8')
    .digest('hex');
}

/**
 * 消息历史去重器类
 */
export class MessageHistory {
  constructor(options = {}) {
    this.storageFile = options.storageFile || '/tmp/claude-feishu-sent-messages.json';
    this.maxSize = options.maxSize || 500;       // 最多保存 500 条历史
    this.ttl = options.ttl || 3600000;           // 1 小时后过期 (60分钟)
    this.flushInterval = options.flushInterval || 60000;  // 1 分钟持久化一次
    this.sentMessages = new Map();               // hash -> timestamp

    this.flushTimer = null;
    this.dirty = false;

    // 加载历史记录
    this._loadFromFile();

    // 启动定时持久化
    this._startFlushTimer();

    Logger.info(`消息历史去重器已初始化 (最大: ${this.maxSize}, TTL: ${this.ttl}ms)`);
    Logger.info(`已加载 ${this.sentMessages.size} 条发送历史`);
  }

  /**
   * 从文件加载历史记录
   * @private
   */
  _loadFromFile() {
    try {
      const data = fs.readFileSync(this.storageFile, 'utf-8');
      const parsed = JSON.parse(data);

      const now = Date.now();
      let loaded = 0;
      let skipped = 0;

      for (const [hash, timestamp] of Object.entries(parsed)) {
        // 检查是否过期
        if (now - timestamp <= this.ttl) {
          this.sentMessages.set(hash, timestamp);
          loaded++;
        } else {
          skipped++;
        }
      }

      Logger.debug(`消息历史加载: ${loaded} 条有效, ${skipped} 条已过期`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        Logger.warn(`加载消息历史失败: ${e.message}`);
      }
      // 文件不存在是正常情况
    }
  }

  /**
   * 保存到文件
   * @private
   */
  _saveToFile() {
    if (!this.dirty) {
      return;
    }

    try {
      const obj = {};
      for (const [hash, timestamp] of this.sentMessages.entries()) {
        obj[hash] = timestamp;
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
      Logger.debug(`消息历史已保存 (${this.sentMessages.size} 条)`);
    } catch (e) {
      Logger.error(`保存消息历史失败: ${e.message}`);
    }
  }

  /**
   * 启动定时持久化
   * @private
   */
  _startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this._saveToFile();
    }, this.flushInterval);
  }

  /**
   * 检查消息是否已发送过
   * @param {string} content - 消息内容
   * @returns {boolean} - 是否已发送过
   */
  hasSent(content) {
    const hash = hashContent(content);
    const timestamp = this.sentMessages.get(hash);

    if (!timestamp) {
      return false;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - timestamp > this.ttl) {
      this.sentMessages.delete(hash);
      this.dirty = true;
      Logger.debug(`消息历史过期: ${hash.substring(0, 8)}...`);
      return false;
    }

    Logger.debug(`消息历史命中: ${hash.substring(0, 8)}...`);
    return true;
  }

  /**
   * 记录消息已发送
   * @param {string} content - 消息内容
   */
  recordSent(content) {
    const hash = hashContent(content);
    const now = Date.now();

    this.sentMessages.set(hash, now);
    this.dirty = true;

    // LRU: 达到上限时删除最旧的记录
    if (this.sentMessages.size > this.maxSize) {
      this._evictOldest();
    }

    Logger.debug(`记录已发送消息: ${hash.substring(0, 8)}...`);
  }

  /**
   * 淘汰最旧的记录
   * @private
   */
  _evictOldest() {
    let oldestHash = null;
    let oldestTime = Infinity;

    for (const [hash, timestamp] of this.sentMessages.entries()) {
      if (timestamp < oldestTime) {
        oldestTime = timestamp;
        oldestHash = hash;
      }
    }

    if (oldestHash) {
      this.sentMessages.delete(oldestHash);
      Logger.debug(`消息历史 LRU 淘汰: ${oldestHash.substring(0, 8)}...`);
    }
  }

  /**
   * 清理过期记录
   */
  cleanup() {
    const now = Date.now();
    const beforeSize = this.sentMessages.size;

    for (const [hash, timestamp] of this.sentMessages.entries()) {
      if (now - timestamp > this.ttl) {
        this.sentMessages.delete(hash);
        this.dirty = true;
      }
    }

    const afterSize = this.sentMessages.size;
    if (beforeSize !== afterSize) {
      Logger.debug(`消息历史清理: ${beforeSize} -> ${afterSize}`);
    }
  }

  /**
   * 立即保存到文件
   */
  flush() {
    this._saveToFile();
  }

  /**
   * 销毁消息历史去重器
   */
  destroy() {
    Logger.info('🧹 销毁消息历史去重器...');

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.flush();

    this.sentMessages.clear();

    Logger.info('✅ 消息历史去重器已销毁');
  }

  /**
   * 获取统计信息
   * @returns {Object}
   */
  getStats() {
    const now = Date.now();
    let freshCount = 0;
    let expiredCount = 0;

    for (const timestamp of this.sentMessages.values()) {
      if (now - timestamp <= this.ttl) {
        freshCount++;
      } else {
        expiredCount++;
      }
    }

    return {
      total: this.sentMessages.size,
      fresh: freshCount,
      expired: expiredCount,
      maxSize: this.maxSize,
      ttl: this.ttl
    };
  }
}

export default MessageHistory;
