/**
 * Claude Code + 飞书桥接服务 - 主入口
 * Author: CodePothunter
 * Version: 1.1.0 - 集成交互消息解析器
 * License: MIT
 */

import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { config, validateConfig, getConfigSummary } from './config/index.js';
import { FeishuAdapter } from './messenger/feishu.js';
import { TmuxCommander } from './tmux/commander.js';
import { StateDetector } from './monitor/detector.js';
import { MessageRouter } from './handlers/router.js';
import { SessionManager } from './session-manager.js';
import { MessageDeduplicator } from './utils/deduplicator.js';
import { MessageHistory } from './utils/message-history.js';
import { TranscriptMonitor } from './transcript-monitor.js';
import { ProcessManager, getGlobalProcessManager } from './utils/process-manager.js';
import Logger from './utils/logger.js';
import { spawn } from 'child_process';

// 全局变量
let messenger = null;
let commander = null;
let detector = null;
let router = null;
let sessionManager = null;
let deduplicator = null;
let messageHistory = null;
let wsClient = null;
let transcriptMonitor = null;
let monitorTimeout = null;
let monitorProcess = null;
let processManager = null;

// WebSocket 连接状态
let isWebSocketConnected = false;
let monitorPaused = false;

/**
 * 打印启动信息
 */
function printStartupInfo() {
  const summary = getConfigSummary();

  Logger.blank();
  Logger.info('╔════════════════════════════════════════════════════════════╗');
  Logger.info('║       Claude Code + 飞书桥接服务 (Modular)                ║');
  Logger.info('╚════════════════════════════════════════════════════════════╝');
  Logger.blank();
  Logger.info(`📱 App ID: ${summary.appId}`);
  Logger.info(`🖥️  当前会话: ${sessionManager.getCurrentSession()}`);
  Logger.info(`⏱️  轮询间隔: ${summary.pollInterval}ms`);
  Logger.info(`📝 Session 文件: ${summary.sessionFile}`);
  Logger.blank();
  Logger.info('📖 使用帮助:');
  Logger.info('   普通文本    → 发送给 Claude Code');
  Logger.info('   yes/no      → 确认/取消操作');
  Logger.info('   !命令       → 执行命令并返回结果');
  Logger.info('   /switch     → 切换 tmux 会话');
  Logger.info('   /help       → 显示帮助信息');
  Logger.blank();
}

/**
 * 启动监控进程
 */
function startMonitorProcess() {
  const sessionName = sessionManager.getCurrentSession();

  Logger.monitor(`启动监控进程 (会话: ${sessionName})`);

  monitorProcess = processManager.spawn('tmux', ['capture-pane', '-p', '-t', sessionName, '-S', '-500'], {
    timeout: 0, // 监控进程不设置超时
    onExit: (code, signal) => {
      Logger.warn(`监控进程已关闭 (code: ${code}, signal: ${signal})`);
    },
    onError: (error) => {
      Logger.error(`监控进程错误: ${error.message}`);
    },
  });

  monitorProcess.stdout.on('data', (data) => {
    sessionManager.buffer.append(data.toString());

    // 执行状态检测
    detector.detect(sessionManager.buffer.get()).then(stateResult => {
      if (stateResult) {
        handleStateChange(stateResult);
      }

      // 更新路由器的监控状态
      if (router) {
        router.setMonitorState(detector.getCurrentState());
      }
    }).catch(error => {
      Logger.error(`状态检测失败: ${error.message}`);
    });
  });

  monitorProcess.stderr.on('data', (data) => {
    Logger.error(`监控进程错误: ${data.toString()}`);
  });

  monitorProcess.on('close', () => {
    Logger.warn('监控进程已关闭');
  });
}

/**
 * 暂停监控轮询（WebSocket 断开时）
 */
function pauseMonitor() {
  if (monitorTimeout && !monitorPaused) {
    clearTimeout(monitorTimeout);
    monitorTimeout = null;
    monitorPaused = true;
    Logger.monitor('监控轮询已暂停（WebSocket 断开）');
  }
}

/**
 * 恢复监控轮询（WebSocket 重连后）
 */
function resumeMonitor() {
  if (monitorPaused) {
    monitorPaused = false;
    Logger.monitor('监控轮询已恢复（WebSocket 重连）');
    startMonitorPolling();
  }
}

/**
 * 启动监控轮询
 */
function startMonitorPolling() {
  const sessionName = sessionManager.getCurrentSession();
  Logger.monitor(`启动监控轮询 (会话: ${sessionName})`);

  function scheduleNextPoll() {
    // WebSocket 断开时暂停轮询
    if (!isWebSocketConnected) {
      Logger.debug('WebSocket 未连接，跳过监控轮询');
      return;
    }

    const currentSession = sessionManager.getCurrentSession();

    // 启动临时进程捕获内容
    const refreshMonitor = processManager.spawn('tmux', ['capture-pane', '-p', '-t', currentSession, '-S', '-500'], {
      timeout: 10000, // 10秒超时
      onExit: (code, signal) => {
        if (code !== 0 && signal !== null) {
          Logger.debug(`capture-pane 进程异常退出 (code: ${code}, signal: ${signal})`);
        }
      },
      onError: (err) => {
        Logger.error(`tmux capture-pane 错误: ${err.message}`);
      },
    });

    let newBuffer = '';

    refreshMonitor.stdout.on('data', (data) => {
      newBuffer += data.toString();
    });

    refreshMonitor.on('close', () => {
      if (newBuffer) {
        sessionManager.buffer.update(newBuffer);

        // 执行状态检测
        detector.detect(newBuffer).then(stateResult => {
          if (stateResult) {
            handleStateChange(stateResult);
          }

          // 更新路由器的监控状态
          if (router) {
            router.setMonitorState(detector.getCurrentState());
          }
        }).catch(error => {
          Logger.error(`状态检测失败: ${error.message}`);
        });
      }

      // WebSocket 仍连接时才调度下次轮询
      if (isWebSocketConnected) {
        const nextInterval = detector.getPollInterval();
        monitorTimeout = setTimeout(scheduleNextPoll, nextInterval);
      }
    });

    refreshMonitor.on('error', (err) => {
      Logger.error(`tmux capture-pane 错误: ${err.message}`);
      // 即使出错也继续调度下次轮询
      const nextInterval = detector.getPollInterval();
      monitorTimeout = setTimeout(scheduleNextPoll, nextInterval);
    });
  }

  // 启动第一次轮询
  monitorTimeout = setTimeout(scheduleNextPoll, config.monitor.pollInterval);
}

/**
 * 处理状态变化
 * 注意：tab_selection、asking_question、confirmation 等交互状态现在由
 * transcript-monitor.js 的 InteractionParser 处理，不再通过 tmux 检测
 * @param {Object} stateResult - 状态检测结果
 */
async function handleStateChange(stateResult) {
  Logger.debug(`状态变化: ${stateResult.type}`);

  try {
    // 清理内容（移除横线等无用字符）
    const cleanContent = (content) => {
      if (!content || typeof content !== 'string') return content;
      return sessionManager.buffer.cleanForNotification(content, 30);
    };

    switch (stateResult.type) {
      // 以下状态已移除，改由 transcript-monitor 的 InteractionParser 处理：
      // - tab_selection (由 AskUserQuestion 处理)
      // - exit_plan_mode (由 AskUserQuestion 处理)
      // - asking_question (由 AskUserQuestion 处理)
      // - confirmation (由 AskUserQuestion 处理)

      case 'error':
        // 错误通知已禁用
        break;

      case 'plan_mode':
      case 'testing':
      case 'git_operation':
      case 'warning':
      case 'idle_input':
        // 这些状态通知已禁用，只在日志中记录
        Logger.debug(`[${stateResult.type}] 状态已检测，不发送飞书通知`);
        break;

      case 'input_prompt':
        await messenger.sendText(`🔔 Claude Code 正在等待输入\n\n当前提示：${cleanContent(stateResult.content)}`);
        break;

      case 'completed':
        await messenger.sendText(`✅ **Claude Code 任务已完成**\n\n正在等待新的输入...`);
        break;

      default:
        // 其他状态也不发送默认通知
        Logger.debug(`[未处理状态: ${stateResult.type}]`);
        break;
    }
  } catch (error) {
    Logger.error(`处理状态变化失败: ${error.message}`);
  }
}

/**
 * 创建事件分发器
 */
function createEventDispatcher() {
  const eventDispatcher = new EventDispatcher({});

  // 初始化去重器
  if (!deduplicator) {
    deduplicator = new MessageDeduplicator({
      ttl: config.deduplication.ttl,
      maxSize: config.deduplication.maxSize,
      cleanupInterval: config.deduplication.cleanupInterval,
      storageFile: config.deduplication.storageFile,
    });
  }

  // 注册消息接收事件处理器
  eventDispatcher.register({
    'im.message.receive_v1': async (data) => {
      try {
        const message = data.message;
        if (!message) {
          Logger.debug('收到空消息事件');
          return;
        }

        const eventId = data.event_id;
        Logger.debug(`收到飞书事件: ${eventId}`);

        // 消息去重检查
        if (deduplicator.isProcessed(eventId)) {
          Logger.info(`🔄 忽略重复事件: ${eventId}`);
          return;
        }

        // 标记为已处理
        deduplicator.markProcessed(eventId);
        Logger.info(`📨 处理新事件: ${eventId}`);

        // 路由消息
        await router.route(message);
      } catch (error) {
        Logger.error(`处理消息事件时出错: ${error}`);
      }
    }
  });

  return eventDispatcher;
}

/**
 * 启动 WebSocket 客户端
 */
async function startWebSocketClient() {
  Logger.socket('启动飞书 WebSocket 长连接...');

  wsClient = new WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: 'info',
    autoReconnect: true,
  });

  const eventDispatcher = createEventDispatcher();

  // 将去重器添加到路由器上下文
  if (router && router.context) {
    router.context.deduplicator = deduplicator;
  }

  try {
    await wsClient.start({
      eventDispatcher: eventDispatcher
    });

    Logger.success('WebSocket 长连接已建立');
    isWebSocketConnected = true;
  } catch (error) {
    Logger.error(`WebSocket 启动失败: ${error.message}`);
    isWebSocketConnected = false;
    throw error;
  }
}

/**
 * 优雅关闭
 */
async function shutdown() {
  Logger.blank();
  Logger.info('🛑 正在关闭服务...');

  try {
    // 停止监控轮询
    if (monitorTimeout) {
      clearTimeout(monitorTimeout);
      Logger.debug('监控轮询已停止');
    }

    // 停止所有管理的进程
    if (processManager) {
      await processManager.stop();
      Logger.debug('进程管理器已停止');
    }

    // 停止监控进程（如果还在运行）
    if (monitorProcess && !monitorProcess.killed) {
      monitorProcess.kill('SIGTERM');
      Logger.debug('监控进程已停止');
    }

    // 销毁去重器（清理定时器和保存数据）
    if (deduplicator) {
      deduplicator.destroy();
      Logger.info('✅ 去重器已销毁');
    }

    // 销毁消息历史去重器
    if (messageHistory) {
      messageHistory.destroy();
      Logger.info('✅ 消息历史去重器已销毁');
    }

    // 停止 transcript 监控
    if (transcriptMonitor) {
      transcriptMonitor.stop();
    }

    // WebSocket 会自动处理连接关闭
    Logger.success('WebSocket 连接已关闭');
  } catch (error) {
    Logger.error(`关闭时出错: ${error.message}`);
  }

  Logger.success('服务已优雅关闭');
  process.exit(0);
}

/**
 * 主启动函数
 */
async function main() {
  try {
    // 验证配置
    validateConfig();

    // 初始化进程管理器
    processManager = new ProcessManager();
    processManager.start();

    // 初始化会话管理器
    sessionManager = new SessionManager();

    // 初始化消息历史去重器
    messageHistory = new MessageHistory();

    // 初始化消息适配器（传入消息历史去重器）
    messenger = new FeishuAdapter({ messageHistory });

    // 初始化 transcript 监控器
    transcriptMonitor = new TranscriptMonitor({
      projectPath: process.cwd(),
      messenger: messenger,
      checkInterval: 500
    });
    transcriptMonitor.start();

    // 初始化命令执行器
    commander = new TmuxCommander(sessionManager.getCurrentSession());

    // 初始化状态检测器
    detector = new StateDetector();

    // 初始化消息路由器
    const context = {
      messenger,
      commander,
      currentSession: sessionManager.getSessionRef(),
      sessionManager,
      monitorState: 'idle',
      sendText: (text) => messenger.sendText(text),
      deduplicator: null,  // 稍后在 createEventDispatcher 后设置
      transcriptMonitor,  // 用于 reset 时重置监控
    };
    router = new MessageRouter(context);

    // 打印启动信息
    printStartupInfo();

    // 自动检测并使用第一个可用会话
    await sessionManager.autoSelectSession();

    // 如果有可用会话，更新 commander、设置 transcript 监控的 tmux session，并启动监控
    if (sessionManager.getCurrentSession()) {
      const sessionName = sessionManager.getCurrentSession();
      commander = new TmuxCommander(sessionName);
      // 设置 transcript 监控的 tmux session 和 commander，使其能够动态获取工作目录并检测 Plan Mode
      if (transcriptMonitor) {
        transcriptMonitor.setTmuxSession(sessionName);
        transcriptMonitor.setTmuxCommander(commander);
        Logger.info(`📝 Transcript 监控将跟踪 tmux 会话: ${sessionName}`);
      }
      startMonitorPolling();
    } else {
      Logger.warn('⚠️  没有可用会话，监控未启动，请使用 /new 命令创建会话');
    }

    // 启动 WebSocket
    await startWebSocketClient();

    Logger.success('服务已启动，等待飞书消息事件...');

    // 注册信号处理器
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // 处理未捕获的异常
    process.on('uncaughtException', async (error) => {
      Logger.error(`未捕获的异常: ${error.message}`);
      Logger.error(error.stack);
      // uncaughtException 通常意味着应用处于不确定状态，应该退出
      await shutdown();
      process.exit(1);
    });

    // 改进的 unhandledRejection 处理
    process.on('unhandledRejection', async (reason, promise) => {
      Logger.error(`未处理的 Promise 拒绝: ${reason}`);

      // 生产环境：记录详细信息并退出
      const isProduction = process.env.NODE_ENV === 'production';

      if (isProduction) {
        Logger.error('生产环境中未处理的 Promise 拒绝，将退出服务');
        await shutdown();
        process.exit(1);
      } else {
        Logger.warn('开发环境：继续运行，但这可能是代码问题');
      }
    });

  } catch (error) {
    Logger.error(`服务启动失败: ${error.message}`);
    process.exit(1);
  }
}

// 启动服务
main();
