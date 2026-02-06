/**
 * 输入验证工具
 * Author: CodePothunter
 * Version: 1.0.0
 */

import { SESSION_NAME_PATTERN, CONFIRMATION_WORDS } from '../config/constants.js';

/**
 * 验证结果类
 */
export class ValidationResult {
  constructor(isValid, error = '') {
    this.isValid = isValid;
    this.error = error;
  }

  static ok() {
    return new ValidationResult(true);
  }

  static fail(error) {
    return new ValidationResult(false, error);
  }
}

/**
 * 验证会话名称
 * @param {string} name - 会话名称
 * @returns {ValidationResult}
 */
export function validateSessionName(name) {
  if (!name || typeof name !== 'string') {
    return ValidationResult.fail('会话名称不能为空');
  }

  if (!SESSION_NAME_PATTERN.test(name)) {
    return ValidationResult.fail(
      '会话名称只能包含字母、数字、下划线、连字符和点'
    );
  }

  if (name.length > 100) {
    return ValidationResult.fail('会话名称不能超过 100 个字符');
  }

  return ValidationResult.ok();
}

/**
 * 验证命令内容（防止命令注入）
 * @param {string} command - 命令内容
 * @returns {ValidationResult}
 */
export function validateCommand(command) {
  if (!command || typeof command !== 'string') {
    return ValidationResult.fail('命令不能为空');
  }

  // 检测潜在的命令注入模式
  const dangerousPatterns = [
    /;\s*rm\s+-rf/,      // 删除命令
    /;\s*dd\s+if=/,      // dd 命令
    /`\s*\$/,            // 命令替换
    /\$\([^)]*\)/,       // 命令替换
    /;\s*curl\s.*\|/,    // curl 管道到 sh
    /;\s*wget\s.*\|/,    // wget 管道到 sh
    /&&\s*rm\s+-rf/,     // && 删除
    /\|\s*rm\s+/,        // 管道到 rm
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return ValidationResult.fail('命令包含危险操作，已被阻止');
    }
  }

  return ValidationResult.ok();
}

/**
 * 验证消息内容
 * @param {string} content - 消息内容
 * @returns {ValidationResult}
 */
export function validateMessageContent(content) {
  if (!content || typeof content !== 'string') {
    return ValidationResult.fail('消息内容不能为空');
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return ValidationResult.fail('消息内容不能为空');
  }

  if (trimmed.length > 10000) {
    return ValidationResult.fail('消息内容不能超过 10000 个字符');
  }

  return ValidationResult.ok();
}

/**
 * 检查是否是确认词
 * @param {string} word - 要检查的词
 * @returns {boolean}
 */
export function isConfirmationWord(word) {
  const lowerWord = word.toLowerCase();
  return CONFIRMATION_WORDS.YES.some(w =>
    lowerWord === w.toLowerCase()
  );
}

/**
 * 检查是否是取消词
 * @param {string} word - 要检查的词
 * @returns {boolean}
 */
export function isCancellationWord(word) {
  const lowerWord = word.toLowerCase();
  return CONFIRMATION_WORDS.NO.some(w =>
    lowerWord === w.toLowerCase()
  );
}

/**
 * 获取确认键类型
 * @param {string} word - 确认词
 * @returns {string} - 'enter' 或 'y'
 */
export function getConfirmationKeyType(word) {
  const lowerWord = word.toLowerCase();

  if (CONFIRMATION_WORDS.ENTER.some(w => lowerWord === w.toLowerCase())) {
    return 'Enter';
  }

  if (['yes', 'y'].includes(lowerWord)) {
    return 'y';
  }

  return 'Enter'; // 默认
}

/**
 * 验证 tab 参数
 * @param {string} args - tab 参数字符串
 * @returns {ValidationResult & {tabs?: number[]}}
 */
export function validateTabArgs(args) {
  if (!args || args.trim() === '') {
    return ValidationResult.fail('请指定 tab 编号');
  }

  const tabs = args.split(',')
    .map(n => parseInt(n.trim()))
    .filter(n => !isNaN(n) && n > 0);

  if (tabs.length === 0) {
    return ValidationResult.fail('无效的 tab 编号');
  }

  if (tabs.some(t => t < 1 || t > 20)) {
    return ValidationResult.fail('tab 编号必须在 1-20 之间');
  }

  return { isValid: true, tabs };
}

/**
 * 清理和验证用户输入
 * @param {string} input - 用户输入
 * @returns {string} - 清理后的输入
 */
export function sanitizeInput(input) {
  if (typeof input !== 'string') {
    return '';
  }

  // 移除控制字符（保留换行和制表符）
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

/**
 * 验证数字选择
 * @param {string} input - 用户输入
 * @returns {boolean}
 */
export function isNumericSelection(input) {
  return /^\d+$/.test(input.trim());
}

export default {
  validateSessionName,
  validateCommand,
  validateMessageContent,
  isConfirmationWord,
  isCancellationWord,
  getConfirmationKeyType,
  validateTabArgs,
  sanitizeInput,
  isNumericSelection,
  ValidationResult,
};
