/**
 * 异步锁工具
 * Author: CodePothunter
 * Version: 1.0.0
 *
 * 提供轻量级的异步锁机制，用于保护共享状态
 * 支持超时和死锁检测
 */

import Logger from './logger.js';

/**
 * 异步锁类
 */
export class AsyncLock {
  /**
   * @param {Object} options - 配置选项
   * @param {number} options.timeout - 锁超时时间（毫秒），默认 30000
   * @param {number} options.deadlockDetectionThreshold - 死锁检测阈值（毫秒），默认 60000
   */
  constructor(options = {}) {
    this.timeout = options.timeout || 30000;
    this.deadlockDetectionThreshold = options.deadlockDetectionThreshold || 60000;
    this.locked = false;
    this.queue = [];
    this.lockTime = null;
    this.lockOwner = null;
    this.waitCount = 0;
  }

  /**
   * 获取锁
   * @param {string} owner - 锁的持有者标识
   * @param {number} timeout - 自定义超时时间
   * @returns {Promise<Function>} - 解锁函数
   */
  async lock(owner = 'unknown', timeout = this.timeout) {
    // 检查是否是同一个持有者（可重入锁）
    if (this.locked && this.lockOwner === owner) {
      Logger.debug(`锁重入: ${owner}`);
      return () => {}; // 已经持有锁，无需解锁
    }

    // 需要等待时才递增计数
    this.waitCount++;

    // 检查死锁
    if (this.locked && this.lockTime) {
      const lockedDuration = Date.now() - this.lockTime;
      if (lockedDuration > this.deadlockDetectionThreshold) {
        Logger.error(`检测到潜在死锁: ${this.lockOwner} 持有锁超过 ${lockedDuration}ms，强制释放`);
        this.locked = false;
        this.lockOwner = null;
        this.lockTime = null;
      }
    }

    return new Promise((resolve, reject) => {
      if (!this.locked) {
        // 立即获取锁 - 递减等待计数
        this.locked = true;
        this.lockOwner = owner;
        this.lockTime = Date.now();
        this.waitCount--;
        Logger.debug(`获取锁成功: ${owner}`);
        resolve(() => this.unlock(owner));
      } else {
        // 等待锁释放
        const timer = setTimeout(() => {
          const idx = this.queue.indexOf(item);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            this.waitCount--;
          }
          reject(new Error(`获取锁超时 (${timeout}ms): ${owner}`));
        }, timeout);

        const item = { owner, resolve, timer };
        this.queue.push(item);
        Logger.debug(`加入等待队列: ${owner} (队列长度: ${this.queue.length})`);
      }
    });
  }

  /**
   * 释放锁
   * @param {string} owner - 锁的持有者标识
   */
  unlock(owner = 'unknown') {
    if (!this.locked) {
      Logger.warn(`尝试释放未持有的锁: ${owner}`);
      return;
    }

    // 检查是否是锁的持有者
    if (this.lockOwner !== owner) {
      Logger.warn(`${owner} 尝试释放 ${this.lockOwner} 持有的锁`);
      return;
    }

    const heldDuration = Date.now() - this.lockTime;
    Logger.debug(`释放锁: ${owner} (持有时间: ${heldDuration}ms)`);

    this.locked = false;
    this.lockOwner = null;
    this.lockTime = null;

    // 唤醒队列中的第一个等待者
    if (this.queue.length > 0) {
      const item = this.queue.shift();
      clearTimeout(item.timer);

      this.locked = true;
      this.lockOwner = item.owner;
      this.lockTime = Date.now();
      this.waitCount--;

      Logger.debug(`锁传递给: ${item.owner}`);
      item.resolve(() => this.unlock(item.owner));
    }
  }

  /**
   * 检查锁是否被持有
   * @returns {boolean}
   */
  isLocked() {
    return this.locked;
  }

  /**
   * 获取锁的持有者
   * @returns {string|null}
   */
  getOwner() {
    return this.lockOwner;
  }

  /**
   * 获取等待队列长度
   * @returns {number}
   */
  getQueueLength() {
    return this.queue.length;
  }

  /**
   * 获取等待计数
   * @returns {number}
   */
  getWaitCount() {
    return this.waitCount;
  }

  /**
   * 强制释放锁（用于死锁恢复）
   */
  forceUnlock() {
    if (this.locked) {
      Logger.warn(`强制释放锁: ${this.lockOwner}`);
      this.locked = false;
      this.lockOwner = null;
      this.lockTime = null;

      // 清空等待队列
      for (const item of this.queue) {
        clearTimeout(item.timer);
        item.resolve(() => this.unlock(item.owner));
      }
      this.queue = [];
      this.waitCount = 0;
    }
  }

  /**
   * 获取锁状态信息
   * @returns {Object}
   */
  getStatus() {
    return {
      locked: this.locked,
      owner: this.lockOwner,
      heldDuration: this.lockTime ? Date.now() - this.lockTime : 0,
      queueLength: this.queue.length,
      waitCount: this.waitCount,
    };
  }
}

/**
 * 命名锁管理器（支持多个独立的锁）
 */
export class NamedLockManager {
  constructor() {
    this.locks = new Map();
  }

  /**
   * 获取指定名称的锁
   * @param {string} name - 锁名称
   * @returns {AsyncLock}
   */
  getLock(name) {
    if (!this.locks.has(name)) {
      this.locks.set(name, new AsyncLock());
    }
    return this.locks.get(name);
  }

  /**
   * 获取锁
   * @param {string} name - 锁名称
   * @param {string} owner - 持有者标识
   * @param {number} timeout - 超时时间
   * @returns {Promise<Function>}
   */
  async lock(name, owner = 'unknown', timeout = 30000) {
    const lock = this.getLock(name);
    return lock.lock(owner, timeout);
  }

  /**
   * 释放锁
   * @param {string} name - 锁名称
   * @param {string} owner - 持有者标识
   */
  unlock(name, owner = 'unknown') {
    const lock = this.locks.get(name);
    if (lock) {
      lock.unlock(owner);
    }
  }

  /**
   * 清理未使用的锁
   */
  cleanup() {
    for (const [name, lock] of this.locks.entries()) {
      if (!lock.isLocked() && lock.getQueueLength() === 0) {
        this.locks.delete(name);
      }
    }
  }

  /**
   * 获取所有锁的状态
   * @returns {Object}
   */
  getStatus() {
    const status = {};
    for (const [name, lock] of this.locks.entries()) {
      status[name] = lock.getStatus();
    }
    return status;
  }
}

/**
 * 互斥执行装饰器（确保同一时间只有一个实例执行）
 * @param {string} lockName - 锁名称
 * @param {Object} options - 配置选项
 * @returns {Function}
 */
export function synchronized(lockName = 'default', options = {}) {
  const manager = new NamedLockManager();

  return function (target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args) {
      const owner = `${target.constructor.name}.${propertyKey}`;
      const unlock = await manager.lock(lockName, owner, options.timeout);

      try {
        return await originalMethod.apply(this, args);
      } finally {
        unlock();
      }
    };

    return descriptor;
  };
}

export default AsyncLock;
