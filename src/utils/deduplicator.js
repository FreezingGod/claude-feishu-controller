/**
 * 消息去重器 - 防止重复处理飞书事件
 * 使用 LRU 缓存 + TTL 过期机制 + 文件持久化
 * Author: CodePothunter
 * Version: 1.0.0
 */

import fs from 'fs';
import path from 'path';
import Logger from './logger.js';

/**
 * 去重器数据结构
 * @typedef {Object} DedupEntry
 * @property {number} timestamp - 事件处理时间戳
 * @property {number} accessTime - 最后访问时间戳（用于 LRU）
 */

export class MessageDeduplicator {
  constructor(options = {}) {
    this.ttl = options.ttl || 300000;           // 5分钟
    this.maxSize = options.maxSize || 1000;      // 最多缓存1000条
    this.storageFile = options.storageFile || '/tmp/claude-feishu-dedup.json';
    this.cleanupInterval = options.cleanupInterval || 60000;  // 1分钟清理一次
    this.flushInterval = options.flushInterval || 30000;  // 30秒持久化一次
    this.processed = new Map();                  // eventId -> { timestamp, accessTime }
    this.dirty = false;                          // 标记是否有未保存的更改

    // 定时器引用（用于清理）
    this.cleanupTimer = null;
    this.flushTimer = null;

    // 加载持久化数据
    this._loadFromFile();

    // 启动定时任务
    this._startCleanupTimer();
    this._startFlushTimer();

    Logger.info(`去重器已初始化 (TTL: ${this.ttl}ms, 最大: ${this.maxSize}, 存储文件: ${this.storageFile})`);
    Logger.info(`已加载 ${this.processed.size} 条历史去重记录`);
  }

  /**
   * 从文件加载已处理的事件
   * @private
   */
  _loadFromFile() {
    try {
      // 直接读取，不存在会抛出 ENOENT
      const data = fs.readFileSync(this.storageFile, 'utf-8');
      const parsed = JSON.parse(data);

      const now = Date.now();
      let loaded = 0;
      let skipped = 0;

      for (const [eventId, entry] of Object.entries(parsed)) {
        // 检查是否过期
        if (now - entry.timestamp <= this.ttl) {
          this.processed.set(eventId, {
            timestamp: entry.timestamp,
            accessTime: entry.accessTime || entry.timestamp
          });
          loaded++;
        } else {
          skipped++;
        }
      }

      Logger.debug(`去重数据加载: ${loaded} 条有效, ${skipped} 条已过期`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        Logger.warn(`加载去重数据失败: ${e.message}`);
      }
      // 文件不存在是正常情况，使用空缓存
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
      for (const [eventId, entry] of this.processed.entries()) {
        obj[eventId] = entry;
      }

      // 确保目录存在
      const dir = path.dirname(this.storageFile);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }

      // 原子写入 + 权限控制
      const tmpFile = this.storageFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(obj), {
        mode: 0o600,  // 仅所有者可读写
        encoding: 'utf-8'
      });
      fs.renameSync(tmpFile, this.storageFile);

      this.dirty = false;
      Logger.debug(`去重数据已保存 (${this.processed.size} 条)`);
    } catch (e) {
      Logger.error(`保存去重数据失败: ${e.message}`);
    }
  }

  /**
   * 检查事件是否已处理过
   * @param {string} eventId - 飞书事件 ID
   * @returns {boolean} 如果事件已处理返回 true
   */
  isProcessed(eventId) {
    if (!eventId) {
      Logger.debug('去重检查: eventId 为空，返回 false');
      return false;
    }

    const entry = this.processed.get(eventId);
    if (!entry) {
      Logger.debug(`去重检查: ${eventId} 未处理过`);
      return false;
    }

    const now = Date.now();
    const age = now - entry.timestamp;

    // 检查是否过期
    if (age > this.ttl) {
      Logger.debug(`去重检查: ${eventId} 已过期 (${age}ms > ${this.ttl}ms)，删除并返回 false`);
      this.processed.delete(eventId);
      this.dirty = true;
      return false;
    }

    // 更新访问时间（真正的 LRU）
    entry.accessTime = now;
    Logger.debug(`去重检查: ${eventId} 已处理过 (${age}ms 前)，返回 true`);
    return true;
  }

  /**
   * 标记事件已处理
   * @param {string} eventId - 飞书事件 ID
   */
  markProcessed(eventId) {
    if (!eventId) {
      Logger.debug('标记事件: eventId 为空，跳过');
      return;
    }

    const now = Date.now();
    const isNew = !this.processed.has(eventId);

    this.processed.set(eventId, {
      timestamp: now,
      accessTime: now
    });

    this.dirty = true;

    if (isNew) {
      Logger.debug(`标记事件: ${eventId} 为已处理`);
    }

    // LRU: 达到上限时删除最久未访问的条目
    if (this.processed.size > this.maxSize) {
      this._evictLRU();
    }
  }

  /**
   * 淘汰最久未访问的条目（真正的 LRU）
   * @private
   */
  _evictLRU() {
    let oldestKey = null;
    let oldestAccess = Infinity;

    for (const [eventId, entry] of this.processed.entries()) {
      if (entry.accessTime < oldestAccess) {
        oldestAccess = entry.accessTime;
        oldestKey = eventId;
      }
    }

    if (oldestKey) {
      this.processed.delete(oldestKey);
      this.dirty = true;
      Logger.debug(`LRU 淘汰: ${oldestKey} (最后访问: ${new Date(oldestAccess).toISOString()})`);
    }
  }

  /**
   * 定期清理过期条目
   * @private
   */
  _startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const beforeSize = this.processed.size;

      for (const [id, entry] of this.processed.entries()) {
        if (now - entry.timestamp > this.ttl) {
          this.processed.delete(id);
          this.dirty = true;
        }
      }

      if (beforeSize !== this.processed.size) {
        Logger.debug(`去重缓存清理: ${beforeSize} -> ${this.processed.size} (删除 ${beforeSize - this.processed.size} 条过期)`);
      }
    }, this.cleanupInterval);
  }

  /**
   * 定期持久化到文件
   * @private
   */
  _startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this._saveToFile();
    }, this.flushInterval);
  }

  /**
   * 销毁去重器，清理所有资源
   */
  destroy() {
    Logger.info('🧹 销毁去重器...');

    // 清理定时器
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 最后一次保存
    this.flush();

    // 清空数据
    this.processed.clear();

    Logger.info('✅ 去重器已销毁');
  }

  /**
   * 立即保存到文件
   */
  flush() {
    this._saveToFile();
  }

  /**
   * 清空缓存（用于测试）
   */
  clear() {
    this.processed.clear();
    this.dirty = true;
    this.flush();
    Logger.debug('去重缓存已清空');
  }

  /**
   * 获取当前缓存大小
   * @returns {number} 缓存中的事件数量
   */
  size() {
    return this.processed.size;
  }

  /**
   * 获取缓存统计信息
   * @returns {Object}
   */
  getStats() {
    const now = Date.now();
    let expiredCount = 0;
    let freshCount = 0;

    for (const entry of this.processed.values()) {
      if (now - entry.timestamp > this.ttl) {
        expiredCount++;
      } else {
        freshCount++;
      }
    }

    return {
      total: this.processed.size,
      fresh: freshCount,
      expired: expiredCount,
      maxSize: this.maxSize,
      ttl: this.ttl
    };
  }
}

export default MessageDeduplicator;
