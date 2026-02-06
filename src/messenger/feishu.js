/**
 * 飞书消息适配器
 * Author: CodePothunter
 * Version: 1.3.0 - 消息历史去重（持久化）
 */

import { Client } from '@larksuiteoapi/node-sdk';
import MessengerAdapter from './adapter.js';
import { config } from '../config/index.js';
import Logger from '../utils/logger.js';
import { withRetry, RetryConfigs, RetryableErrors } from '../utils/retry.js';
import { MessageHistory } from '../utils/message-history.js';
import { toLarkMarkdown } from '../utils/feishu-markdown.js';
import { markdownToFeishuRichText } from '../utils/feishu-rich-text.js';

/**
 * 飞书适配器类
 */
export class FeishuAdapter extends MessengerAdapter {
  /**
   * @param {Object} options - 配置选项
   */
  constructor(options = {}) {
    super();

    this.appId = options.appId || config.feishu.appId;
    this.appSecret = options.appSecret || config.feishu.appSecret;
    this.userChatId = options.userChatId || config.feishu.userChatId;

    // 初始化消息历史去重器
    this.messageHistory = options.messageHistory || new MessageHistory();

    // 初始化飞书客户端
    this.client = new Client({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: 'info',
      disableCache: true,
    });

    Logger.success(`飞书 SDK 已初始化 (App ID: ${this.appId})`);
  }

  /**
   * 设置消息历史去重器
   * @param {MessageHistory} messageHistory - 消息历史实例
   */
  setMessageHistory(messageHistory) {
    this.messageHistory = messageHistory;
  }

  /**
   * 检测文本是否包含复杂 Markdown 格式（需要富文本支持）
   * @param {string} text - 文本内容
   * @returns {boolean}
   */
  hasComplexMarkdown(text) {
    // 检测标题
    if (/^#{1,6}\s/.test(text)) {
      return true;
    }

    // 检测代码块
    if (/```[\s\S]*?```/.test(text)) {
      return true;
    }

    // 检测引用块
    if (/^>\s/.test(text)) {
      return true;
    }

    // 检测有序列表
    if (/^\d+\.\s/.test(text)) {
      return true;
    }

    return false;
  }

  /**
   * 发送富文本消息（支持标题、代码块等复杂格式）
   * @param {string} text - Markdown 文本
   * @param {Object} options - 发送选项
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendRichText(text, options = {}) {
    const { skipDedup = false } = options;

    // 检查是否已发送过
    if (!skipDedup && this.messageHistory && this.messageHistory.hasSent(text)) {
      Logger.debug(`🔄 消息已发送过，跳过: ${text.substring(0, 50)}...`);
      return { success: true, skipped: true };
    }

    try {
      // 转换 Markdown 为飞书富文本格式
      const richTextContent = markdownToFeishuRichText(text, {
        maxCodeBlockLength: 3000
      });

      // 调试日志：打印生成的富文本内容
      const contentStr = JSON.stringify(richTextContent);
      Logger.debug(`富文本原始长度: ${text.length}, JSON长度: ${contentStr.length}`);
      Logger.debug(`富文本内容: ${JSON.stringify(richTextContent, null, 2)}`);
      Logger.debug(`即将发送的content字段: ${contentStr.substring(0, 500)}...`);

      await withRetry(async () => {
        await this.client.im.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: this.userChatId,
            msg_type: 'post',
            content: contentStr
          }
        });
      }, RetryConfigs.feishu);

      // 记录已发送
      if (!skipDedup && this.messageHistory) {
        this.messageHistory.recordSent(text);
      }

      Logger.feishu('富文本消息已发送');
      return { success: true };
    } catch (error) {
      // 打印更详细的错误信息
      const errorData = error?.response?.data || {};
      Logger.error(`飞书富文本消息发送失败: ${error.message || error}`);
      Logger.error(`API 错误详情: ${JSON.stringify(errorData)}`);
      Logger.error(`错误码: ${error?.response?.status || 'N/A'}`);
      // 如果富文本发送失败，尝试用普通文本
      Logger.warn(`尝试降级为普通文本发送`);
      return this.sendText(text, { ...options, useRichText: false });
    }
  }

  /**
   * 发送文本消息（支持 Markdown，带重试和去重）
   * @param {string} text - 消息文本
   * @param {Object} options - 发送选项
   * @param {boolean} options.skipDedup - 跳过去重检查
   * @param {boolean} options.skipMarkdownConversion - 跳过 Markdown 转换
   * @param {boolean} options.useRichText - 强制使用富文本格式
   * @param {boolean} options.forceSimple - 强制使用简单格式（不自动检测）
   * @returns {Promise<{success: boolean, skipped?: boolean, error?: string}>}
   */
  async sendText(text, options = {}) {
    const {
      skipDedup = false,
      skipMarkdownConversion = false,
      useRichText = null, // null = 自动检测
      forceSimple = false
    } = options;

    // 检查是否已发送过（除非跳过去重）
    if (!skipDedup && this.messageHistory && this.messageHistory.hasSent(text)) {
      Logger.debug(`🔄 消息已发送过，跳过: ${text.substring(0, 50)}...`);
      return { success: true, skipped: true };
    }

    // 禁用富文本功能：飞书 post 类型不支持 heading、code 等标签
    // 所有消息统一使用 interactive 类型 + lark_md（已支持 Markdown）
    const shouldUseRichText = false;  // 强制禁用

    if (shouldUseRichText) {
      Logger.debug('检测到复杂 Markdown 格式，使用富文本消息');
      return this.sendRichText(text, { skipDedup });
    }

    // 转换 Markdown 为飞书兼容格式
    const processedText = skipMarkdownConversion ? text : toLarkMarkdown(text, {
      maxCodeBlockLength: 3000,
      preserveEmptyLines: false,
      enableEmoji: true,
    });

    try {
      await withRetry(async () => {
        await this.client.im.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: this.userChatId,
            msg_type: 'interactive',
            content: JSON.stringify({
              config: {
                wide_screen_mode: true
              },
              elements: [
                {
                  tag: 'div',
                  text: {
                    tag: 'lark_md',
                    content: processedText
                  }
                }
              ]
            })
          }
        });
      }, RetryConfigs.feishu);

      // 记录已发送（使用原始文本）
      if (!skipDedup && this.messageHistory) {
        this.messageHistory.recordSent(text);
      }

      Logger.feishu('消息已发送');
      return { success: true };
    } catch (error) {
      Logger.error(`飞书消息发送失败: ${error.message || error}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 发送卡片消息（带重试）
   * @param {string} title - 卡片标题
   * @param {string} content - 卡片内容
   * @param {Array} buttons - 按钮列表
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendCard(title, content, buttons = []) {
    try {
      await withRetry(async () => {
        // 转换 Markdown 为飞书兼容格式
        const processedContent = toLarkMarkdown(`**${title}**\n\n${content}`, {
          maxCodeBlockLength: 2000,
          preserveEmptyLines: false,
        });

        const elements = [{
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: processedContent
          }
        }];

        if (buttons.length > 0) {
          const buttonElement = {
            tag: 'action',
            actions: buttons
          };
          elements.push(buttonElement);
        }

        await this.client.im.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: this.userChatId,
            msg_type: 'interactive',
            content: JSON.stringify({
              config: {
                wide_screen_mode: true
              },
              elements
            })
          }
        });
      }, RetryConfigs.feishu);

      Logger.feishu('卡片已发送');
      return { success: true };
    } catch (error) {
      Logger.error(`飞书卡片发送失败: ${error.message || error}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 发送 Tab 选择通知
   * @param {Object} data - Tab 选择数据
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendTabSelection(data) {
    let message = '📋 **Claude Code 需要您选择**\n\n';

    if (data.description) {
      message += `📝 ${data.description}\n\n`;
    }

    // 显示 Tabs 状态
    if (data.tabs && data.tabs.length > 0) {
      message += '**🏷️ Tab 状态：**\n';
      data.tabs.forEach((tab, idx) => {
        const isChecked = data.checkedTabs?.includes(idx);
        const icon = isChecked ? '☑️' : '⬜';
        message += `${icon} ${idx + 1}. ${tab}\n`;
      });
      message += `\n使用 \`/tab <数字>\` 切换选中状态\n`;
      message += `例如：\`/tab 1\` 只选中第1个，\`/tab 1,2\` 选中多个\n\n`;
    }

    if (data.options && data.options.length > 0) {
      message += '**请回复数字选择：**\n\n';
      for (const opt of data.options) {
        message += `${opt.num}. ${opt.text}`;
        if (opt.description) {
          message += `\n   └─ ${opt.description}`;
        }
        message += '\n';
      }

      // 检测特殊选项
      const specialOptions = data.options.filter(o =>
        o.text.includes('Chat about this') ||
        o.text.includes('Skip interview') ||
        o.text.includes('Type something')
      );

      if (specialOptions.length > 0) {
        message += `\n💡 **操作方式**：\n`;
        message += `• 回复数字（如 \`1\`）确认当前选择\n`;
        message += `• \`${specialOptions.find(o => o.text.includes('Chat'))?.num || '5'}\` 进入对话模式\n`;
        message += `• \`${specialOptions.find(o => o.text.includes('Skip'))?.num || '6'}\` 跳过确认`;
      } else {
        message += `\n💡 直接回复数字确认选择`;
      }
    }

    // 使用 skipMarkdownConversion 选项，因为消息格式已经优化过
    return this.sendText(message, { skipMarkdownConversion: false });
  }

  /**
   * 发送状态更新
   * @param {string} status - 状态类型
   * @param {string} message - 状态消息
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendStatus(status, message) {
    const icons = {
      tab_selection: '📋',
      error: '❌',
      asking_question: '❓',
      confirmation: '⚠️',
      plan_mode: '📋',
      testing: '🧪',
      git_operation: '🔀',
      input_prompt: '🔔',
      warning: '⚠️',
      completed: '✅',
      idle_input: '🔔',
    };

    const icon = icons[status] || 'ℹ️';
    return this.sendText(`${icon} ${message}`);
  }

  /**
   * 发送错误通知
   * @param {string} error - 错误消息
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendError(error) {
    return this.sendText(`❌ ${error}`);
  }

  /**
   * 发送成功通知
   * @param {string} message - 成功消息
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendSuccess(message) {
    return this.sendText(`✅ ${message}`);
  }

  /**
   * 发送帮助信息
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendHelp() {
    const helpMessage = `📖 **Claude Code 飞书桥接 - 帮助**

---

🔔 **监控功能**

* 自动检测 Claude Code 等待输入
* 检测错误、警告、测试执行等状态
* 飞书消息实时通知

---

💬 **使用规则**

* **普通文本** → 直接发送给 Claude Code
* **yes/y/确认** → 确认 Claude Code 请求
* **no/n/取消** → 取消 Claude Code 操作
* **!命令** → 在 tmux 中执行命令并返回结果

---

🎛️ **桥接服务指令**

* **/switch** — 列出所有 tmux 会话
* **/switch <名>** — 切换监控到指定会话
* **/tab <数字>** — 选中指定 tab（如 \`/tab 1\`）
* **/tab <数字>,<数字>** — 选中多个 tab（如 \`/tab 1,2\`）
* **/show** — 显示当前 tmux 会话内容
* **/new <名字>** — 创建新的 tmux 会话
* **/kill** — 杀掉当前 tmux 会话
* **/reset** — 清除 Claude Code context window
* **/history** — 查看命令历史
* **/status** — 显示详细状态信息
* **/config** — 查看当前配置
* **/dedup-stats** — 查看去重器状态（防止历史消息重放）
* **/watch** — 实时跟随输出
* **/clear** — 清空监控缓冲区
* **/help** — 显示此帮助信息

---

💡 **示例**

* \`!pwd\` — 显示当前目录
* \`!ls -la\` — 列出文件
* \`!git status\` — 查看 git 状态`;

    return this.sendText(helpMessage, { skipMarkdownConversion: false });
  }

  /**
   * 发送 AskUserQuestion 交互消息
   * @param {Object} question - 问题对象
   * @param {string} question.text - 问题文本
   * @param {string} question.header - 问题标题/头部
   * @param {Array} question.options - 选项列表
   * @param {boolean} question.multiSelect - 是否多选
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendAskUserQuestion(question) {
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

    return this.sendText(message, { skipMarkdownConversion: false });
  }
}

export default FeishuAdapter;
