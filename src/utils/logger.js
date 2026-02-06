/**
 * 统一日志工具
 * Author: CodePothunter
 * Version: 1.0.0
 */

import { config } from '../config/index.js';

// 日志级别
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// 当前日志级别
let currentLevel = LOG_LEVELS[config.logger.level.toUpperCase()] || LOG_LEVELS.INFO;

// ANSI 颜色代码
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// 图标
const ICONS = {
  debug: '🔍',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
  success: '✅',
  socket: '🔌',
  message: '📨',
  monitor: '👀',
  tmux: '🖥️',
  feishu: '📤',
  http: '🌐',
  transcript: '📝',
  health: '📊',
  fallback: '🔄',
};

/**
 * 格式化时间戳
 */
function getTimestamp() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * 核心日志函数
 */
function log(level, icon, color, message, ...args) {
  if (LOG_LEVELS[level] < currentLevel) {
    return;
  }

  const timestamp = getTimestamp();
  const prefix = `${COLORS.gray}[${timestamp}]${COLORS.reset} ${icon} ${color}[${level}]${COLORS.reset}`;

  console.log(prefix, message, ...args);
}

/**
 * Logger 类
 */
export class Logger {
  /**
   * 设置日志级别
   */
  static setLevel(level) {
    const upperLevel = level.toUpperCase();
    if (LOG_LEVELS[upperLevel] !== undefined) {
      currentLevel = LOG_LEVELS[upperLevel];
    }
  }

  /**
   * 获取当前日志级别
   */
  static getLevel() {
    return Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === currentLevel);
  }

  /**
   * Debug 级别日志
   */
  static debug(message, ...args) {
    log('DEBUG', ICONS.debug, COLORS.cyan, message, ...args);
  }

  /**
   * Info 级别日志
   */
  static info(message, ...args) {
    log('INFO', ICONS.info, COLORS.blue, message, ...args);
  }

  /**
   * Warn 级别日志
   */
  static warn(message, ...args) {
    log('WARN', ICONS.warn, COLORS.yellow, message, ...args);
  }

  /**
   * Error 级别日志
   */
  static error(message, ...args) {
    log('ERROR', ICONS.error, COLORS.red, message, ...args);
  }

  /**
   * 成功消息
   */
  static success(message, ...args) {
    log('INFO', ICONS.success, COLORS.green, message, ...args);
  }

  /**
   * Socket 相关日志
   */
  static socket(message, ...args) {
    log('INFO', ICONS.socket, COLORS.magenta, message, ...args);
  }

  /**
   * 消息相关日志
   */
  static message(message, ...args) {
    log('INFO', ICONS.message, COLORS.cyan, message, ...args);
  }

  /**
   * 监控相关日志
   */
  static monitor(message, ...args) {
    log('INFO', ICONS.monitor, COLORS.magenta, message, ...args);
  }

  /**
   * Tmux 相关日志
   */
  static tmux(message, ...args) {
    log('INFO', ICONS.tmux, COLORS.green, message, ...args);
  }

  /**
   * 飞书相关日志
   */
  static feishu(message, ...args) {
    log('INFO', ICONS.feishu, COLORS.blue, message, ...args);
  }

  /**
   * HTTP 相关日志
   */
  static http(message, ...args) {
    log('INFO', ICONS.http, COLORS.magenta, message, ...args);
  }

  /**
   * Transcript 相关日志
   */
  static transcript(message, ...args) {
    log('INFO', ICONS.transcript, COLORS.cyan, message, ...args);
  }

  /**
   * 健康检查相关日志
   */
  static health(message, ...args) {
    log('INFO', ICONS.health, COLORS.green, message, ...args);
  }

  /**
   * 降级管理相关日志
   */
  static fallback(message, ...args) {
    log('INFO', ICONS.fallback, COLORS.yellow, message, ...args);
  }

  /**
   * 空行
   */
  static blank() {
    console.log();
  }
}

export default Logger;
