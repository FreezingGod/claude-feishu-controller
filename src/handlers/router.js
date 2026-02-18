/**
 * 消息路由器
 * Author: CodePothunter
 * Version: 1.1.0 - 添加消息队列和并发保护
 */

import { COMMAND_PREFIXES } from '../config/constants.js';
import { isConfirmationWord, isCancellationWord, isNumericSelection, sanitizeInput } from '../utils/validator.js';
import * as commands from './command.js';
import Logger from '../utils/logger.js';
import { AsyncLock } from '../utils/async-lock.js';

/**
 * 消息路由器类
 */
export class MessageRouter {
  /**
   * @param {Object} context - 上下文对象
   */
  constructor(context) {
    this.context = context;
    this.commandHandlers = new Map();
    this.messageQueue = [];
    this.isProcessing = false;
    this.routeLock = new AsyncLock({ timeout: 30000 });
    this.maxQueueSize = 100;

    // 注册命令处理器
    this.registerCommands();
  }

  /**
   * 获取上下文（用于动态更新）
   */
  getContext() {
    return this.context;
  }

  /**
   * 注册命令处理器
   */
  registerCommands() {
    // /switch - 无参数：列出会话
    this.commandHandlers.set('switch', async (args) => {
      if (args) {
        return commands.handleSwitchTo(this.context, args);
      }
      return commands.handleSwitchList(this.context);
    });

    // /tab
    this.commandHandlers.set('tab', async (args) => commands.handleTab(this.context, args));

    // /show
    this.commandHandlers.set('show', async () => commands.handleShow(this.context));

    // /new
    this.commandHandlers.set('new', async (args) => commands.handleNew(this.context, args));

    // /kill
    this.commandHandlers.set('kill', async () => commands.handleKill(this.context));

    // /help 或 /h
    this.commandHandlers.set('help', async () => commands.handleHelp(this.context));
    this.commandHandlers.set('h', async () => commands.handleHelp(this.context));

    // /history
    this.commandHandlers.set('history', async () => commands.handleHistory(this.context));

    // /status
    this.commandHandlers.set('status', async () => commands.handleStatus(this.context, this.context.monitorState));

    // /config
    this.commandHandlers.set('config', async () => commands.handleConfig(this.context));

    // /watch
    this.commandHandlers.set('watch', async () => commands.handleWatch(this.context));

    // /clear
    this.commandHandlers.set('clear', async () => commands.handleClear(this.context));

    // /dedup-stats
    this.commandHandlers.set('dedup-stats', async () => commands.handleDedupStats(this.context));

    // /reset - 清除 Claude Code context
    this.commandHandlers.set('reset', async () => commands.handleReset(this.context));
  }

  /**
   * 解析消息内容
   * @param {Object} message - 消息对象（飞书或标准化格式）
   * @returns {string} - 解析后的文本内容
   */
  parseMessageContent(message) {
    // 标准化消息格式（来自 Discord 等非飞书平台）
    if (message._normalized) {
      return sanitizeInput(message.text || '');
    }

    // 飞书消息解析
    let messageContent = '';

    try {
      const contentObj = JSON.parse(message.content);

      // 处理 post 类型（富文本消息）
      if (message.message_type === 'post' && contentObj.content) {
        for (const paragraph of contentObj.content) {
          for (const element of paragraph) {
            if (element.tag === 'text') {
              messageContent += element.text || '';
            } else if (element.tag === 'a') {
              messageContent += element.text || element.href || '';
            }
          }
          messageContent += '\n';
        }
      } else {
        // 处理普通文本消息
        messageContent = contentObj.text || '';
      }
    } catch (e) {
      messageContent = message.content || '';
    }

    return sanitizeInput(messageContent.trim());
  }

  /**
   * 路由消息到对应的处理器（带队列和并发保护）
   * @param {Object} message - 飞书消息对象
   * @returns {Promise<void>}
   */
  async route(message) {
    // 检查是否是自己发送的消息（飞书）
    if (message.sender && message.sender.sender_type === 'app') {
      return;
    }
    // 过滤 bot 消息（Discord 等标准化消息）
    if (message._isBot) {
      return;
    }

    // 添加到队列
    if (this.messageQueue.length >= this.maxQueueSize) {
      Logger.warn('消息队列已满，丢弃最旧的消息');
      this.messageQueue.shift();
    }
    this.messageQueue.push(message);

    // 如果正在处理，等待
    if (this.isProcessing) {
      Logger.debug(`消息队列长度: ${this.messageQueue.length}`);
      return;
    }

    // 处理队列
    this.processQueue();
  }

  /**
   * 处理消息队列
   */
  async processQueue() {
    if (this.isProcessing || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    // 先取出消息，避免锁失败后重复处理
    const message = this.messageQueue.shift();

    // 获取锁
    const unlock = await this.routeLock.lock('MessageRouter.processQueue').catch(err => {
      Logger.error(`获取路由锁失败: ${err.message}`);
      return null;
    });

    try {
      if (!unlock) {
        // 锁获取失败，消息已被 shift 丢弃，记录日志
        Logger.warn(`消息处理失败（锁获取超时），已丢弃`);
        return;
      }

      // 处理消息
      await this.routeInternal(message);

      // 处理完成后，检查队列中是否有更多消息
      if (this.messageQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    } catch (error) {
      Logger.error(`处理消息时出错: ${error.message}`);
    } finally {
      // 确保 unlock 被调用
      if (unlock) {
        unlock();
      }
      this.isProcessing = false;

      // 异常情况下也要检查是否有新消息需要处理
      if (this.messageQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  /**
   * 内部路由实现
   * @param {Object} message - 飞书消息对象
   * @returns {Promise<void>}
   */
  async routeInternal(message) {
    try {
      const content = this.parseMessageContent(message);
      if (!content) {
        return;
      }

      const contentLower = content.toLowerCase();

      // 简洁输出：只显示关键命令
      if (content.startsWith('/') || content.startsWith('!')) {
        Logger.message(content);
      }

      // 处理特殊命令
      if (content === '速速停止') {
        Logger.warn('收到"速速停止"，发送 ESC');
        await this.context.commander.sendEscape();
        await this.context.sendText('⚠️ 已发送 ESC 中断');
        return;
      }

      // 处理 ! 前缀命令（执行命令并返回结果）
      if (content.startsWith(COMMAND_PREFIXES.EXECUTE)) {
        const command = content.slice(1).trim();
        if (command) {
          await commands.handleExecute(this.context, command);
        }
        return;
      }

      // 处理 / 前缀命令（桥接服务指令）
      if (content.startsWith(COMMAND_PREFIXES.BRIDGE)) {
        const parts = content.slice(1).trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');

        const handler = this.commandHandlers.get(cmd);
        if (handler) {
          await handler(args);
        } else {
          await this.context.sendText(`❓ 未知指令: /${cmd}\n\n使用 /help 查看帮助`);
        }
        return;
      }

      // 处理确认/同意
      if (isConfirmationWord(content)) {
        await commands.handleConfirm(this.context, content);
        return;
      }

      // 处理拒绝/取消
      if (isCancellationWord(content)) {
        await commands.handleCancel(this.context);
        return;
      }

      // 处理数字选择
      if (isNumericSelection(content)) {
        await commands.handleNumberSelect(this.context, content.trim());
        return;
      }

      // 处理普通文本（发送给 Claude Code）
      await commands.handleSendText(this.context, content);
    } catch (error) {
      Logger.error(`路由消息时出错: ${error.message}`);
    }
  }

  /**
   * 设置监控状态（用于 /status 命令）
   * @param {string} state - 当前监控状态
   */
  setMonitorState(state) {
    this.context.monitorState = state;
  }
}

export default MessageRouter;
