/**
 * 状态检测器（策略模式）
 * Author: CodePothunter
 * Version: 2.0.0 - 极简版本，只保留基本检测能力
 *
 * 说明：
 * - 大部分状态检测已移除，改用 transcript.jsonl + InteractionParser
 * - 本检测器只保留基本的状态跟踪能力
 */

import patterns from './patterns.js';
import Logger from '../utils/logger.js';
import { POLL_INTERVALS } from '../config/constants.js';
import { AsyncLock } from '../utils/async-lock.js';

/**
 * 状态检测器类
 */
export class StateDetector {
  constructor() {
    this.detectLock = new AsyncLock({ timeout: 10000 });
    this.detectors = [];
    this.currentState = 'idle';
    this.lastState = 'idle';
    this.lastAlertTime = 0;
    this.lastDebugLogTime = 0;
    this.detectorLastTrigger = new Map();
    this.triggeredStates = new Set();
    this.startupTime = Date.now();
    this.silencePeriod = 10000;

    this.registerDefaultDetectors();
  }

  /**
   * 检查是否在启动静默期内
   * @returns {boolean}
   */
  isInSilencePeriod() {
    return Date.now() - this.startupTime < this.silencePeriod;
  }

  /**
   * 重置静默期（用于测试或手动控制）
   */
  resetSilencePeriod() {
    this.startupTime = Date.now();
  }

  /**
   * 注册检测器
   * @param {Object} detector - 检测器配置
   */
  register(detector) {
    const { name, priority, detect, handler, cooldown = 10000 } = detector;

    this.detectors.push({
      name,
      priority,
      detect,
      handler,
      cooldown,
    });

    // 按优先级排序
    this.detectors.sort((a, b) => b.priority - a.priority);

    Logger.debug(`注册检测器: ${name} (优先级: ${priority})`);
  }

  /**
   * 注册默认检测器
   * 大部分检测已移除，改用 transcript.jsonl + InteractionParser
   */
  registerDefaultDetectors() {
    // 无默认检测器
    // 所有状态检测由 transcript-monitor.js 的 InteractionParser 处理
  }

  /**
   * 检测当前状态（带并发保护）
   * @param {string} buffer - 缓冲区内容
   * @returns {Promise<Object|null>} - 匹配的状态结果
   */
  async detect(buffer) {
    // 如果已经持有锁，直接执行（避免重入死锁）
    if (this.detectLock.isLocked() && this.detectLock.getOwner() === 'detect') {
      return this.detectInternal(buffer);
    }

    // 获取锁后执行检测
    const unlock = await this.detectLock.lock('detect');
    try {
      return this.detectInternal(buffer);
    } finally {
      unlock();
    }
  }

  /**
   * 内部检测实现
   * @param {string} buffer - 缓冲区内容
   * @returns {Object|null} - 匹配的状态结果
   */
  detectInternal(buffer) {
    const now = Date.now();
    const inSilencePeriod = this.isInSilencePeriod();

    if (inSilencePeriod) {
      Logger.debug('启动静默期，更新状态但不发送通知');
    }

    // 记录本轮匹配的状态
    const currentMatchedStates = new Set();

    // 按优先级检测各状态
    for (const detector of this.detectors) {
      if (detector.detect(buffer)) {
        currentMatchedStates.add(detector.name);

        if (this.triggeredStates.has(detector.name)) {
          continue;
        }

        const lastTrigger = this.detectorLastTrigger.get(detector.name) || 0;

        if (now - lastTrigger < detector.cooldown) {
          continue;
        }

        this.detectorLastTrigger.set(detector.name, now);
        this.lastAlertTime = now;
        this.lastState = detector.name;
        this.triggeredStates.add(detector.name);
        Logger.debug(`检测到状态: ${detector.name}`);

        if (!inSilencePeriod) {
          return detector.handler(buffer);
        }
      }
    }

    this.triggeredStates = currentMatchedStates;

    return null;
  }

  /**
   * 获取当前状态
   * @returns {string}
   */
  getCurrentState() {
    return this.lastState;
  }

  /**
   * 获取推荐的轮询间隔
   * @returns {number}
   */
  getPollInterval() {
    if (this.lastState === 'idle') {
      return POLL_INTERVALS.IDLE;
    }
    return POLL_INTERVALS.DEFAULT;
  }

  /**
   * 重置状态
   */
  reset() {
    this.lastState = 'idle';
    this.lastAlertTime = 0;
    this.detectorLastTrigger.clear();
  }
}

export default StateDetector;
