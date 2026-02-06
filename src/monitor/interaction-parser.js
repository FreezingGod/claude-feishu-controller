/**
 * 交互消息解析器
 * 从 jsonl 中解析 Claude Code 的交互消息
 * Author: CodePothunter
 * Version: 1.0.0
 */

import Logger from '../utils/logger.js';

/**
 * 交互类型枚举
 */
export const InteractionType = {
  ASK_USER_QUESTION: 'ask_user_question',
  // 未来可扩展：
  // CONFIRMATION: 'confirmation',
  // TAB_SELECTION: 'tab_selection',
};

/**
 * 交互消息解析器类
 */
export class InteractionParser {
  constructor() {
    // 内部指令前缀（用于过滤不需要发送的内容）
    this.internalPrefixes = [
      '[SUGGESTION MODE:',
      '[SKILL MODE:',
      '[MODE:',
      '[INTERNAL]',
      '<thinking>',
    ];
  }

  /**
   * 判断消息是否包含 AskUserQuestion tool_use
   * @param {Object} data - jsonl 消息数据
   * @returns {boolean}
   */
  isAskUserQuestion(data) {
    if (!data || !data.message || !data.message.content) {
      return false;
    }

    const content = data.message.content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some(
      c => c.type === 'tool_use' && c.name === 'AskUserQuestion'
    );
  }

  /**
   * 判断消息是否包含 tool_use（任何类型）
   * @param {Object} data - jsonl 消息数据
   * @returns {boolean}
   */
  hasToolUse(data) {
    if (!data || !data.message || !data.message.content) {
      return false;
    }

    const content = data.message.content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some(c => c.type === 'tool_use');
  }

  /**
   * 判断消息是否包含 thinking 内容
   * @param {Object} data - jsonl 消息数据
   * @returns {boolean}
   */
  hasThinking(data) {
    if (!data || !data.message || !data.message.content) {
      return false;
    }

    const content = data.message.content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some(c => {
      if (c.type === 'text' && c.text) {
        return c.text.startsWith('<thinking>') ||
               c.text.includes('[SUGGESTION MODE:]') ||
               c.text.includes('[SKILL MODE:]') ||
               c.text.includes('[INTERNAL]');
      }
      return false;
    });
  }

  /**
   * 判断消息是否只包含纯文本（不含 tool_use、thinking）
   * @param {Object} data - jsonl 消息数据
   * @returns {boolean}
   */
  isPureText(data) {
    if (!data || !data.message || !data.message.content) {
      return false;
    }

    const content = data.message.content;
    if (!Array.isArray(content)) {
      return false;
    }

    // 必须包含 text
    const hasText = content.some(c => c.type === 'text' && c.text && c.text.trim());
    if (!hasText) {
      return false;
    }

    // 不能包含 tool_use
    if (this.hasToolUse(data)) {
      return false;
    }

    // 不能包含 thinking 或内部指令
    if (this.hasThinking(data)) {
      return false;
    }

    return true;
  }

  /**
   * 解析 AskUserQuestion 消息
   * @param {Object} data - jsonl 消息数据
   * @returns {Object|null} - 解析后的交互数据
   */
  parseAskUserQuestion(data) {
    if (!this.isAskUserQuestion(data)) {
      return null;
    }

    try {
      const toolUse = data.message.content.find(c => c.type === 'tool_use' && c.name === 'AskUserQuestion');
      if (!toolUse || !toolUse.input || !toolUse.input.questions) {
        Logger.warn('AskUserQuestion 格式异常，缺少 questions');
        return null;
      }

      const questions = toolUse.input.questions;
      if (!Array.isArray(questions) || questions.length === 0) {
        Logger.warn('AskUserQuestion questions 为空');
        return null;
      }

      // 提取第一个问题（通常只有一个）
      const question = questions[0];

      return {
        type: InteractionType.ASK_USER_QUESTION,
        uuid: data.uuid,
        question: {
          text: question.question || '',
          header: question.header || '',
          options: question.options || [],
          multiSelect: question.multiSelect || false,
        }
      };
    } catch (error) {
      Logger.error(`解析 AskUserQuestion 失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 解析交互消息（自动识别类型）
   * @param {Object} data - jsonl 消息数据
   * @returns {Object|null} - 解析后的交互数据
   */
  parse(data) {
    // 优先解析 AskUserQuestion
    if (this.isAskUserQuestion(data)) {
      return this.parseAskUserQuestion(data);
    }

    // 未来可扩展其他交互类型

    return null;
  }

  /**
   * 判断消息是否应该发送给用户
   * @param {Object} data - jsonl 消息数据
   * @returns {{send: boolean, interaction: Object|null, pureText: boolean}}
   */
  shouldSendMessage(data) {
    // 首先检查是否是交互消息
    const interaction = this.parse(data);
    if (interaction) {
      return { send: true, interaction, pureText: false };
    }

    // 检查是否是纯文本消息
    if (this.isPureText(data)) {
      return { send: true, interaction: null, pureText: true };
    }

    // 其他情况不发送（tool_use、thinking、内部指令等）
    return { send: false, interaction: null, pureText: false };
  }

  /**
   * 提取消息的文本内容
   * @param {Object} data - jsonl 消息数据
   * @returns {string}
   */
  extractText(data) {
    if (!data || !data.message || !data.message.content) {
      return '';
    }

    const content = data.message.content;
    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('\n');
  }
}

export default new InteractionParser();
