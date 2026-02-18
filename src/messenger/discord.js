/**
 * Discord 消息适配器
 * Author: CodePothunter
 * Version: 1.0.0
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import MessengerAdapter from './adapter.js';
import Logger from '../utils/logger.js';
import { withRetry, RetryConfigs } from '../utils/retry.js';
import { DISCORD } from '../config/constants.js';

/**
 * Discord 重试配置
 */
const DiscordRetryConfig = {
  maxAttempts: 3,
  delays: [1000, 2000, 5000],
  isRetryable: (err) => {
    if (!err) return false;
    const message = err.message?.toLowerCase() || '';
    // Discord API 限流或网络错误可重试
    return (
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      (err.status && err.status >= 500)
    );
  },
};

/**
 * Discord 适配器类
 */
export class DiscordAdapter extends MessengerAdapter {
  /**
   * @param {Object} options - 配置选项
   * @param {Object} options.client - discord.js Client 实例
   * @param {string} options.channelId - 目标频道 ID
   * @param {Object} options.messageHistory - 消息历史去重器
   */
  constructor(options = {}) {
    super();

    this.client = options.client;
    this.channelId = options.channelId;
    this.messageHistory = options.messageHistory || null;
    this.channel = null;

    // Discord 特定的消息长度限制
    this.maxMessageLength = DISCORD.MAX_MESSAGE_LENGTH;
    this.splitThreshold = DISCORD.SPLIT_THRESHOLD;

    Logger.success(`Discord 适配器已初始化 (频道: ${this.channelId})`);
  }

  /**
   * 获取目标频道
   * @returns {Promise<Object>} Discord 频道对象
   */
  async getChannel() {
    if (this.channel) {
      return this.channel;
    }

    this.channel = await this.client.channels.fetch(this.channelId);
    if (!this.channel) {
      throw new Error(`无法找到频道: ${this.channelId}`);
    }
    return this.channel;
  }

  /**
   * 分割消息为多个片段，保持代码块完整性
   * @param {string} text - 原始消息
   * @param {number} maxLen - 每片最大长度
   * @returns {string[]} 消息片段数组
   */
  splitMessage(text, maxLen = DISCORD.SPLIT_THRESHOLD) {
    if (text.length <= maxLen) {
      return [text];
    }

    const chunks = [];
    // 跟踪是否在代码块内
    let inCodeBlock = false;
    let codeBlockLang = '';

    // 按段落分割
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';

    for (const para of paragraphs) {
      // 检测代码块状态
      const codeBlockMatches = para.match(/```/g);
      if (codeBlockMatches) {
        const count = codeBlockMatches.length;
        if (count % 2 !== 0) {
          // 奇数个 ``` 意味着代码块状态翻转
          if (!inCodeBlock) {
            const langMatch = para.match(/```(\w*)/);
            codeBlockLang = langMatch ? langMatch[1] : '';
          }
          inCodeBlock = !inCodeBlock;
        }
      }

      const separator = currentChunk ? '\n\n' : '';
      const testChunk = currentChunk + separator + para;

      if (testChunk.length <= maxLen) {
        currentChunk = testChunk;
      } else {
        // 保存当前块
        if (currentChunk) {
          // 如果当前块在代码块中间被截断，关闭代码块
          if (inCodeBlock && !currentChunk.trimEnd().endsWith('```')) {
            currentChunk += '\n```';
          }
          chunks.push(currentChunk);
        }

        // 处理单段落超长
        if (para.length > maxLen) {
          const lines = para.split('\n');
          let lineChunk = '';

          for (const line of lines) {
            const testLine = lineChunk + (lineChunk ? '\n' : '') + line;
            if (testLine.length <= maxLen) {
              lineChunk = testLine;
            } else {
              if (lineChunk) {
                chunks.push(lineChunk);
              }
              // 单行超长，强制分割
              if (line.length > maxLen) {
                for (let i = 0; i < line.length; i += maxLen) {
                  chunks.push(line.slice(i, i + maxLen));
                }
                lineChunk = '';
              } else {
                lineChunk = line;
              }
            }
          }
          // 如果在代码块中间开始新块，重新打开代码块
          if (inCodeBlock) {
            currentChunk = '```' + codeBlockLang + '\n' + lineChunk;
          } else {
            currentChunk = lineChunk;
          }
        } else {
          // 如果在代码块中间开始新块，重新打开代码块
          if (inCodeBlock && !para.trimStart().startsWith('```')) {
            currentChunk = '```' + codeBlockLang + '\n' + para;
          } else {
            currentChunk = para;
          }
        }
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks.length > 0 ? chunks : [text.slice(0, maxLen)];
  }

  /**
   * 发送文本消息（支持 Markdown，带自动分片和去重）
   * @param {string} text - 消息文本
   * @param {Object} options - 发送选项
   * @returns {Promise<{success: boolean, skipped?: boolean, error?: string}>}
   */
  async sendText(text, options = {}) {
    const { skipDedup = false } = options;

    // 去重检查
    if (!skipDedup && this.messageHistory && this.messageHistory.hasSent(text)) {
      Logger.debug(`[Discord] 消息已发送过，跳过: ${text.substring(0, 50)}...`);
      return { success: true, skipped: true };
    }

    try {
      const channel = await this.getChannel();
      const chunks = this.splitMessage(text, DISCORD.SPLIT_THRESHOLD);

      if (chunks.length > 1) {
        Logger.info(`[Discord] 消息过长 (${text.length} 字符)，分 ${chunks.length} 片发送`);
      }

      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `\`[${i + 1}/${chunks.length}]\`\n` : '';

        await withRetry(async () => {
          await channel.send(prefix + chunks[i]);
        }, DiscordRetryConfig);

        // 分片间延迟避免限流
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // 记录已发送
      if (!skipDedup && this.messageHistory) {
        this.messageHistory.recordSent(text);
      }

      Logger.info('[Discord] 消息已发送');
      return { success: true };
    } catch (error) {
      Logger.error(`[Discord] 消息发送失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 发送卡片消息（使用 Discord Embed）
   * @param {string} title - 卡片标题
   * @param {string} content - 卡片内容
   * @param {Array} buttons - 按钮列表
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendCard(title, content, buttons = []) {
    try {
      const channel = await this.getChannel();

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(content.slice(0, DISCORD.MAX_EMBED_DESCRIPTION))
        .setColor(0x7C3AED);

      const messageOptions = { embeds: [embed] };

      // 添加按钮（如果有）
      if (buttons.length > 0) {
        const row = new ActionRowBuilder();
        for (const btn of buttons.slice(0, 5)) { // Discord 每行最多 5 个按钮
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(btn.value || btn.text || `btn_${Math.random()}`)
              .setLabel((btn.text || btn.label || 'Button').slice(0, 80))
              .setStyle(ButtonStyle.Primary)
          );
        }
        messageOptions.components = [row];
      }

      await withRetry(async () => {
        await channel.send(messageOptions);
      }, DiscordRetryConfig);

      Logger.info('[Discord] 卡片消息已发送');
      return { success: true };
    } catch (error) {
      Logger.error(`[Discord] 卡片发送失败: ${error.message}`);
      return { success: false, error: error.message };
    }
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
   * 发送 Tab 选择通知
   * @param {Object} data - Tab 选择数据
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendTabSelection(data) {
    let message = '📋 **Claude Code 需要您选择**\n\n';

    if (data.description) {
      message += `📝 ${data.description}\n\n`;
    }

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
      message += `\n💡 直接回复数字确认选择`;
    }

    return this.sendText(message);
  }

  /**
   * 发送 AskUserQuestion 交互消息
   * @param {Object} question - 问题对象
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

    return this.sendText(message);
  }

  /**
   * 发送帮助信息
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendHelp() {
    const embed = new EmbedBuilder()
      .setTitle('📖 Claude Code Discord 桥接 - 帮助')
      .setColor(0x7C3AED)
      .addFields(
        {
          name: '🔔 监控功能',
          value: [
            '• 自动检测 Claude Code 等待输入',
            '• 检测错误、警告、测试执行等状态',
            '• Discord 消息实时通知',
          ].join('\n'),
        },
        {
          name: '💬 使用规则',
          value: [
            '**普通文本** → 直接发送给 Claude Code',
            '**yes/y/确认** → 确认 Claude Code 请求',
            '**no/n/取消** → 取消 Claude Code 操作',
            '**!命令** → 在 tmux 中执行命令并返回结果',
          ].join('\n'),
        },
        {
          name: '🎛️ 桥接服务指令',
          value: [
            '`/switch` — 列出所有 tmux 会话',
            '`/switch <名>` — 切换监控到指定会话',
            '`/tab <数字>` — 选中指定 tab',
            '`/show` — 显示当前 tmux 会话内容',
            '`/new <名字>` — 创建新的 tmux 会话',
            '`/kill` — 杀掉当前 tmux 会话',
            '`/reset` — 清除 Claude Code context',
            '`/history` — 查看命令历史',
            '`/status` — 显示详细状态信息',
            '`/help` — 显示此帮助信息',
          ].join('\n'),
        },
        {
          name: '💡 示例',
          value: '`!pwd` — 显示当前目录\n`!ls -la` — 列出文件\n`!git status` — 查看 git 状态',
        }
      );

    try {
      const channel = await this.getChannel();
      await withRetry(async () => {
        await channel.send({ embeds: [embed] });
      }, DiscordRetryConfig);

      Logger.info('[Discord] 帮助信息已发送');
      return { success: true };
    } catch (error) {
      Logger.error(`[Discord] 帮助信息发送失败: ${error.message}`);
      // 降级为纯文本
      return this.sendText(
        '📖 **Claude Code Discord 桥接 - 帮助**\n\n' +
        '**普通文本** → 发送给 Claude Code\n' +
        '**yes/no** → 确认/取消操作\n' +
        '**!命令** → 执行命令并返回结果\n' +
        '`/switch` `/show` `/new` `/kill` `/reset` `/status` `/help`'
      );
    }
  }
}

export default DiscordAdapter;
