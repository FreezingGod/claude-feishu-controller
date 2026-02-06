/**
 * 缓冲区管理
 * Author: CodePothunter
 * Version: 1.0.0
 */

import { config } from '../config/index.js';
import Logger from '../utils/logger.js';

/**
 * 缓冲区管理类
 */
export class BufferManager {
  /**
   * @param {Object} options - 配置选项
   */
  constructor(options = {}) {
    this.maxSize = options.maxSize || config.monitor.maxBufferLength;
    this.minSize = options.minSize || config.monitor.minBufferLength;
    this.buffer = '';
  }

  /**
   * 更新缓冲区内容
   * @param {string} content - 新内容
   */
  update(content) {
    this.buffer = content;
    this.trimIfNeeded();
  }

  /**
   * 追加内容到缓冲区
   * @param {string} content - 要追加的内容
   */
  append(content) {
    this.buffer += content;
    this.trimIfNeeded();
  }

  /**
   * 获取缓冲区内容
   * @param {number} length - 返回的最后 N 个字符
   * @returns {string}
   */
  get(length = null) {
    if (length && length > 0) {
      return this.buffer.slice(-length);
    }
    return this.buffer;
  }

  /**
   * 获取最后 N 行
   * @param {number} lines - 行数
   * @returns {string}
   */
  getLastLines(lines = 100) {
    const allLines = this.buffer.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  /**
   * 清空缓冲区
   */
  clear() {
    const oldLength = this.buffer.length;
    this.buffer = '';
    Logger.debug(`缓冲区已清空 (${oldLength} 字符)`);
  }

  /**
   * 检查是否需要清理并执行
   */
  trimIfNeeded() {
    if (this.buffer.length > this.maxSize) {
      const beforeLength = this.buffer.length;
      this.buffer = this.buffer.slice(-this.minSize);
      Logger.debug(`缓冲区已清理: ${beforeLength} -> ${this.buffer.length} 字符`);
    }
  }

  /**
   * 获取缓冲区大小
   * @returns {number}
   */
  size() {
    return this.buffer.length;
  }

  /**
   * 检查缓冲区是否为空
   * @returns {boolean}
   */
  isEmpty() {
    return this.buffer.length === 0;
  }

  /**
   * 搜索内容
   * @param {string|RegExp} pattern - 搜索模式
   * @returns {boolean}
   */
  contains(pattern) {
    if (pattern instanceof RegExp) {
      return pattern.test(this.buffer);
    }
    return this.buffer.includes(pattern);
  }

  /**
   * 获取匹配的行
   * @param {RegExp} pattern - 正则表达式
   * @returns {string[]}
   */
  getMatchingLines(pattern) {
    const lines = this.buffer.split('\n');
    return lines.filter(line => pattern.test(line));
  }

  /**
   * 清理显示内容（移除多余的空白行和横线）
   * @param {number} maxLength - 最大长度
   * @returns {string}
   */
  getCleanedContent(maxLength = 3000) {
    const cleaned = this.buffer
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;

        // 过滤各种类型的纯横线（包括 Unicode 字符）
        // 匹配由重复横线字符组成的行（长度 >= 30）
        const horizontalLinePattern = /^([─━│┃┄┅┆┇┈┉┊┋┌┍┎┏\=\-\*])\1{29,}$/;
        if (horizontalLinePattern.test(trimmed)) return false;

        // 过滤连续横线混合其他字符的情况（如 ─────────）
        if (/^[─\-\=│\*]{30,}$/.test(trimmed)) return false;

        return true;
      })
      .join('\n')
      .slice(-maxLength);

    return cleaned;
  }

  /**
   * 清理内容用于通知（更激进的过滤）
   * @param {string} content - 原始内容
   * @param {number} maxLines - 最大行数
   * @returns {string}
   */
  cleanForNotification(content, maxLines = 50) {
    const lines = content.split('\n');
    const result = [];

    for (let i = 0; i < lines.length && result.length < maxLines; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 跳过空行
      if (!trimmed) continue;

      // 跳过横线
      const horizontalLinePattern = /^([─━│┃┄┅┆┇┈┉┊┋┌┍┎┏\=\-\*│┌┐└┘├┤┬┴┼─])\1{10,}$/;
      if (horizontalLinePattern.test(trimmed)) continue;
      if (/^[─\-\=│\*]{20,}$/.test(trimmed)) continue;

      result.push(line);
    }

    return result.join('\n');
  }
}

export default BufferManager;
