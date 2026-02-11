/**
 * 命令处理器
 * Author: CodePothunter
 * Version: 1.0.0
 */

import TmuxSession from '../tmux/session.js';
import { validateTabArgs, isConfirmationWord, isCancellationWord, getConfirmationKeyType } from '../utils/validator.js';
import Logger from '../utils/logger.js';

/**
 * 命令处理器上下文
 */
class CommandContext {
  constructor(messenger, commander, currentSession, sessionManager) {
    this.messenger = messenger;
    this.commander = commander;
    this.currentSession = currentSession;
    this.sessionManager = sessionManager;
  }

  async sendText(text) {
    return this.messenger.sendText(text);
  }
}

/**
 * /switch 命令 - 列出所有 tmux 会话
 */
export async function handleSwitchList(ctx) {
  try {
    Logger.info('/switch: 列出所有 tmux 会话');

    const { sessions, error } = await TmuxSession.list();

    if (error) {
      await ctx.sendText(`❌ 获取会话列表失败: ${error}`);
      return;
    }

    if (sessions.length === 0) {
      await ctx.sendText('📭 当前没有 tmux 会话\n\n使用 `/new <名字>` 创建新会话');
      return;
    }

    let message = `📋 **tmux 会话列表** (${sessions.length}个)\n\n`;
    message += `📍 当前监控: **${ctx.currentSession.value}**\n\n`;

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const isCurrent = session === ctx.currentSession.value;
      const workingDir = await TmuxSession.getWorkingDir(session);
      const dirDisplay = workingDir ? workingDir.replace(/^\/home\/ubuntu\//, '~/') : 'unknown';
      const status = isCurrent ? '🟢 当前' : '';

      message += `**${session}** ${status}\n`;
      message += `└─ 📁 \`${dirDisplay}\`\n\n`;
    }

    message += `💡 使用 \`/switch <名字>\` 切换监控目标`;

    await ctx.sendText(message);
  } catch (error) {
    Logger.error(`/switch 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /switch 命令失败: ${error.message}`);
  }
}

/**
 * /switch <name> 命令 - 切换到指定会话
 */
export async function handleSwitchTo(ctx, sessionName) {
  try {
    const { validateSessionName } = await import('../utils/validator.js');

    // 验证会话名称
    const validation = validateSessionName(sessionName);
    if (!validation.isValid) {
      await ctx.sendText(`❌ ${validation.error}`);
      return;
    }

    const { sessions, error } = await TmuxSession.list();

    if (error) {
      await ctx.sendText(`❌ 获取会话列表失败: ${error}`);
      return;
    }

    if (!sessions.includes(sessionName)) {
      await ctx.sendText(`❌ 会话 "${sessionName}" 不存在\n\n使用 /switch 查看所有会话`);
      return;
    }

    const oldSession = ctx.currentSession.value;
    ctx.currentSession.value = sessionName;
    ctx.commander.setSession(sessionName);
    await ctx.sessionManager.save(sessionName);

    // 获取新 session 的工作目录，用于更新 transcript 监控路径
    const workingDir = await TmuxSession.getWorkingDir(sessionName);
    if (ctx.transcriptMonitor) {
      // 更新 tmux session 名称
      ctx.transcriptMonitor.setTmuxSession(sessionName);
      // 更新 transcript 监控器的项目路径
      if (workingDir) {
        ctx.transcriptMonitor.updateProjectPath(workingDir);
        Logger.transcript(`Transcript 监控路径更新为: ${workingDir}`);
      }
    }

    await ctx.sendText(
      `✅ 已切换监控目标\n\n` +
      `从: ${oldSession}\n` +
      `到: **${sessionName}**${workingDir ? `\n\n📁 工作目录: ${workingDir}` : ''}`
    );
    Logger.tmux(`切换监控: ${oldSession} -> ${sessionName}`);
  } catch (error) {
    Logger.error(`切换会话失败: ${error.message}`);
    await ctx.sendText(`❌ 切换会话失败: ${error.message}`);
  }
}

/**
 * /tab 命令 - 控制 tab 选中状态（简化版本）
 */
export async function handleTab(ctx, args) {
  try {
    const validation = validateTabArgs(args);
    if (!validation.isValid) {
      await ctx.sendText(`❌ ${validation.error}\n\n用法: \`/tab <数字>\` 或 \`/tab <数字>,<数字>\`\n示例: \`/tab 1\` 只选中第1个，\`/tab 1,2\` 选中第1和第2个`);
      return;
    }

    const targetTabs = validation.tabs;
    Logger.tmux(`切换 tab 选中状态: ${targetTabs.join(', ')}`);

    // 简化实现：直接发送 Tab 和 Space 组合
    // 先按几次 Tab 确保回到起始位置，然后选中目标
    await ctx.commander.sendKey('Escape'); // 先关闭可能打开的菜单
    await new Promise(r => setTimeout(r, 100));

    // 选中目标 tab
    for (const tabIdx of targetTabs) {
      for (let i = 0; i < Math.max(0, tabIdx - 1); i++) {
        await ctx.commander.sendKey('Tab');
        await new Promise(r => setTimeout(r, 50));
      }
      await ctx.commander.sendKey('Space');
      await new Promise(r => setTimeout(r, 50));
    }

    const tabList = targetTabs.map(t => `☑️ ${t}`).join('\n');
    await ctx.sendText(`✅ 已选中 tab：\n\n${tabList}\n\n💡 回复 \`yes\` 确认选择`);
  } catch (error) {
    Logger.error(`/tab 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /tab 命令失败: ${error.message}`);
  }
}

/**
 * 清理内容（移除横线等），从后往前获取最新的内容
 */
function cleanContent(content, maxLines = 50) {
  const lines = content.split('\n');
  const result = [];

  // 从后往前遍历，获取最新的内容
  for (let i = lines.length - 1; i >= 0 && result.length < maxLines; i--) {
    const line = lines[i];
    const trimmed = line.trim();

    // 跳过空行
    if (!trimmed) continue;

    // 跳过各种类型的纯横线
    const horizontalLinePattern = /^([─━│┃┄┅┆┇┈┉┊┋┌┍┎┏\=\-\*│┌┐└┘├┤┬┴┼─])\1{10,}$/;
    if (horizontalLinePattern.test(trimmed)) continue;
    if (/^[─\-\=│\*]{20,}$/.test(trimmed)) continue;

    result.unshift(line); // 添加到开头，保持顺序
  }

  return result.join('\n');
}

/**
 * /show 命令 - 显示当前进度
 */
export async function handleShow(ctx) {
  try {
    // 捕获更多行以确保获取到最新输出
    const content = await ctx.commander.capture(500);

    // 使用统一的清理函数，获取最新的 80 行
    const cleaned = cleanContent(content, 80);

    const message = `📺 **当前会话: ${ctx.currentSession.value}**\n\n\`\`\`\n${cleaned}\n\`\`\``;
    await ctx.sendText(message);
  } catch (error) {
    Logger.error(`/show 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /show 命令失败: ${error.message}`);
  }
}

/**
 * /new 命令 - 创建新项目目录和 tmux 会话
 * 用法: /new <project-name>
 * 会在当前工作目录的上一层目录创建同名目录和 tmux session
 */
export async function handleNew(ctx, projectName) {
  try {
    const { validateSessionName } = await import('../utils/validator.js');

    if (!projectName || projectName.trim() === '') {
      await ctx.sendText(
        '❌ 请指定项目名称\n\n' +
        '用法: `/new <项目名称>`\n' +
        '示例: `/new my-new-project`\n\n' +
        '会在当前工作目录的上一层目录创建同名目录和 tmux session'
      );
      return;
    }

    projectName = projectName.trim();
    const validation = validateSessionName(projectName);

    if (!validation.isValid) {
      await ctx.sendText(`❌ ${validation.error}`);
      return;
    }

    // 检查 session 是否已存在
    const { sessions, error: listError } = await TmuxSession.list();
    if (listError) {
      await ctx.sendText(`❌ 获取会话列表失败: ${listError}`);
      return;
    }

    if (sessions && sessions.includes(projectName)) {
      await ctx.sendText(`❌ 会话 "${projectName}" 已存在\n\n使用 /switch 切换到该会话`);
      return;
    }

    // 获取当前 session 的工作目录
    const currentWorkingDir = await TmuxSession.getWorkingDir(ctx.currentSession.value);
    if (!currentWorkingDir) {
      await ctx.sendText(`❌ 无法获取当前会话的工作目录`);
      return;
    }

    // 计算新项目目录：当前目录的父目录 + 项目名
    const path = await import('path');
    const parentDir = path.dirname(currentWorkingDir);
    const newProjectDir = path.join(parentDir, projectName);

    // 检查项目目录是否已存在
    const fs = await import('fs');
    if (fs.existsSync(newProjectDir)) {
      await ctx.sendText(
        `⚠️ 目录 "${newProjectDir}" 已存在\n\n` +
        `将使用现有目录创建 tmux session`
      );
    } else {
      // 创建新目录
      try {
        fs.mkdirSync(newProjectDir, { recursive: true });
        Logger.tmux(`创建项目目录: ${newProjectDir}`);
      } catch (mkdirError) {
        await ctx.sendText(`❌ 创建目录失败: ${mkdirError.message}`);
        return;
      }
    }

    // 创建 tmux session，指定工作目录
    const result = await TmuxSession.create(projectName, newProjectDir);

    if (!result.success) {
      await ctx.sendText(`❌ 创建会话失败: ${result.error}`);
      return;
    }

    await ctx.sendText(
      `✅ 已创建新项目\n\n` +
      `📁 项目目录: ${newProjectDir}\n` +
      `🖥️  Session 名称: **${projectName}**\n\n` +
      `💡 使用 \`/switch ${projectName}\` 切换到新会话`
    );
    Logger.tmux(`创建新项目: ${projectName} -> ${newProjectDir}`);
  } catch (error) {
    Logger.error(`/new 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /new 命令失败: ${error.message}`);
  }
}

/**
 * /kill 命令 - 杀掉当前 tmux 会话
 */
export async function handleKill(ctx) {
  try {
    Logger.tmux(`杀掉 tmux 会话: ${ctx.currentSession.value}`);

    const { sessions } = await TmuxSession.list();

    if (sessions.length === 0) {
      await ctx.sendText('❌ 没有可杀掉的会话');
      return;
    }

    if (sessions.length === 1) {
      await ctx.sendText(
        '⚠️ 这是最后一个会话，杀掉后将无法监控\n\n' +
        '确定要杀掉吗？发送 `yes` 确认'
      );
      return;
    }

    const killedSession = ctx.currentSession.value;

    await TmuxSession.kill(killedSession);

    // 切换到第一个可用会话
    const { sessions: remainingSessions } = await TmuxSession.list();
    const newSession = remainingSessions[0] || null;

    if (newSession) {
      ctx.currentSession.value = newSession;
      ctx.commander.setSession(newSession);
      await ctx.sessionManager.save(newSession);

      // 获取新 session 的工作目录，用于更新 transcript 监控路径
      const workingDir = await TmuxSession.getWorkingDir(newSession);
      if (workingDir && ctx.transcriptMonitor) {
        ctx.transcriptMonitor.updateProjectPath(workingDir);
        Logger.transcript(`Transcript 监控路径更新为: ${workingDir}`);
      }

      await ctx.sendText(
        `✅ 已杀掉会话: ${killedSession}\n\n` +
        `📍 切换到: **${newSession}**${workingDir ? `\n📁 工作目录: ${workingDir}` : ''}`
      );
    } else {
      await ctx.sendText(`✅ 已杀掉会话: ${killedSession}\n\n⚠️ 没有剩余会话，请创建新会话`);
    }

    Logger.tmux(`杀掉会话: ${killedSession}, 当前: ${ctx.currentSession.value}`);
  } catch (error) {
    Logger.error(`/kill 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /kill 命令失败: ${error.message}`);
  }
}

/**
 * /help 命令 - 显示帮助信息
 */
export async function handleHelp(ctx) {
  return ctx.messenger.sendHelp();
}

/**
 * /history 命令 - 查看命令历史
 */
export async function handleHistory(ctx) {
  try {
    const history = ctx.sessionManager.getHistory();
    if (history.length === 0) {
      await ctx.sendText('📜 **命令历史**\n\n暂无历史记录');
      return;
    }

    let message = '📜 **命令历史** (最近 20 条)\n\n';
    history.slice(-20).forEach((cmd, idx) => {
      message += `${idx + 1}. ${cmd}\n`;
    });

    await ctx.sendText(message);
  } catch (error) {
    Logger.error(`/history 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /history 命令失败: ${error.message}`);
  }
}

/**
 * /status 命令 - 显示详细状态信息
 */
export async function handleStatus(ctx, monitorState) {
  try {
    const { sessions } = await TmuxSession.list();
    const buffer = ctx.sessionManager.buffer;

    let message = '📊 **系统状态**\n\n';
    message += `**当前会话**: ${ctx.currentSession.value}\n`;
    message += `**监控状态**: ${monitorState || 'idle'}\n`;
    message += `**缓冲区大小**: ${buffer.size()} 字符\n`;
    message += `**会话总数**: ${sessions.length}\n\n`;

    // 列出所有会话
    if (sessions.length > 0) {
      message += '**可用会话**:\n';
      for (const session of sessions) {
        const isCurrent = session === ctx.currentSession.value;
        message += `${isCurrent ? '🟢' : '⚪'} ${session}\n`;
      }
    }

    await ctx.sendText(message);
  } catch (error) {
    Logger.error(`/status 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /status 命令失败: ${error.message}`);
  }
}

/**
 * /config 命令 - 查看当前配置
 */
export async function handleConfig(ctx) {
  try {
    const { getConfigSummary } = await import('../config/index.js');
    const summary = getConfigSummary();

    let message = '⚙️ **当前配置**\n\n';
    message += `**App ID**: ${summary.appId}\n`;
    message += `**Session 文件**: ${summary.sessionFile}\n`;
    message += `**默认会话**: ${summary.defaultSession}\n`;
    message += `**轮询间隔**: ${summary.pollInterval}ms\n`;
    message += `**缓冲区大小**: ${summary.bufferSize}\n`;

    await ctx.sendText(message);
  } catch (error) {
    Logger.error(`/config 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /config 命令失败: ${error.message}`);
  }
}

/**
 * /watch 命令 - 实时跟随输出
 */
export async function handleWatch(ctx) {
  try {
    const content = await ctx.commander.capture(200);
    const cleaned = ctx.sessionManager.buffer.getCleanedContent(5000);

    await ctx.sendText(`👁️ **实时输出**\n\n\`\`\`\n${cleaned}\n\`\`\`\n\n💡 使用 /show 查看更多内容`);
  } catch (error) {
    Logger.error(`/watch 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /watch 命令失败: ${error.message}`);
  }
}

/**
 * /clear 命令 - 清空缓冲区
 */
export async function handleClear(ctx) {
  try {
    ctx.sessionManager.buffer.clear();
    await ctx.sendText('🧹 缓冲区已清空');
  } catch (error) {
    Logger.error(`/clear 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /clear 命令失败: ${error.message}`);
  }
}

/**
 * /dedup-stats 命令 - 显示去重器统计信息
 */
export async function handleDedupStats(ctx) {
  try {
    // deduplicator 从 context 中获取
    const deduplicator = ctx.deduplicator;
    if (!deduplicator) {
      await ctx.sendText('❌ 去重器未初始化');
      return;
    }

    const stats = deduplicator.getStats();
    const ttlMinutes = Math.round(stats.ttl / 60000);

    let message = '🔄 **去重器状态**\n\n';
    message += `**总记录数**: ${stats.total}\n`;
    message += `**有效记录**: ${stats.fresh}\n`;
    message += `**过期记录**: ${stats.expired}\n`;
    message += `**最大容量**: ${stats.maxSize}\n`;
    message += `**TTL**: ${ttlMinutes} 分钟\n`;
    message += `**使用率**: ${Math.round(stats.total / stats.maxSize * 100)}%\n\n`;

    if (stats.expired > 0) {
      message += `💡 提示: 有 ${stats.expired} 条过期记录将在下次清理时移除\n\n`;
    }

    message += `💡 去重数据会自动保存到文件，重启后仍然有效`;

    await ctx.sendText(message);
  } catch (error) {
    Logger.error(`/dedup-stats 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /dedup-stats 命令失败: ${error.message}`);
  }
}

/**
 * /reset 命令 - 清除 Claude Code 的 context window
 * 相当于向 Claude Code 发送 /clear 命令
 * 同时重置 transcript 监控以检测新 session
 */
export async function handleReset(ctx) {
  try {
    Logger.info('清除 Claude Code context window');

    // 发送 /clear 命令到 Claude Code
    await ctx.commander.sendCommand('/clear');

    // 重置 transcript 监控，以便检测新创建的 session
    if (ctx.transcriptMonitor) {
      ctx.transcriptMonitor.reset();
      Logger.transcript('Transcript 监控已重置，等待新 session 创建');
    }

    await ctx.sendText('✅ 已发送 `/clear` 命令到 Claude Code\n\n💡 Context window 已清除，正在检测新 session...');
  } catch (error) {
    Logger.error(`/reset 命令失败: ${error.message}`);
    await ctx.sendText(`❌ /reset 命令失败: ${error.message}`);
  }
}

/**
 * 处理确认响应
 */
export async function handleConfirm(ctx, word) {
  try {
    const key = getConfirmationKeyType(word);
    await ctx.sendText(`✅ 已确认 (${word})`);

    if (key === 'Enter') {
      await ctx.commander.sendKey('Enter');
    } else {
      await ctx.commander.sendKey(key);
      await new Promise(r => setTimeout(r, 50));
      await ctx.commander.sendKey('Enter');
    }
  } catch (error) {
    Logger.error(`确认失败: ${error.message}`);
    await ctx.sendText(`❌ 确认失败: ${error.message}`);
  }
}

/**
 * 处理取消响应
 */
export async function handleCancel(ctx) {
  try {
    await ctx.sendText('❌ 已取消');
    await ctx.commander.cancel();
  } catch (error) {
    Logger.error(`取消失败: ${error.message}`);
    await ctx.sendText(`❌ 取消失败: ${error.message}`);
  }
}

/**
 * 处理数字选择
 */
export async function handleNumberSelect(ctx, number) {
  try {
    Logger.message(`收到数字回复: ${number}`);
    await ctx.commander.sendCommand(number);
  } catch (error) {
    Logger.error(`发送数字失败: ${error.message}`);
    await ctx.sendText(`❌ 发送失败: ${error.message}`);
  }
}

/**
 * 处理普通文本发送
 */
export async function handleSendText(ctx, text) {
  try {
    // 截断过长的消息内容，避免飞书消息过长
    const MAX_PREVIEW_LENGTH = 500;
    const previewText = text.length > MAX_PREVIEW_LENGTH
      ? text.slice(0, MAX_PREVIEW_LENGTH) + `... (已截断，共 ${text.length} 字符)`
      : text;

    await ctx.sendText(`📤 正在发送命令到 Claude Code...\n\n> ${previewText}`);
    await ctx.commander.sendCommand(text);
  } catch (error) {
    Logger.error(`发送命令失败: ${error.message}`);
    await ctx.sendText(`❌ 发送命令失败: ${error.message}`);
  }
}

/**
 * 处理命令执行 (!前缀)
 */
export async function handleExecute(ctx, command) {
  try {
    Logger.info(`执行命令: ${command}`);
    const result = await ctx.commander.execute(command);

    if (result.success) {
      await ctx.sendText(`💻 \`$ ${command}\`\n\n${result.output}`);
    } else {
      await ctx.sendText(`❌ 执行命令失败: ${result.error}`);
    }
  } catch (error) {
    Logger.error(`执行命令失败: ${error.message}`);
    await ctx.sendText(`❌ 执行命令失败: ${error.message}`);
  }
}

export default {
  handleSwitchList,
  handleSwitchTo,
  handleTab,
  handleShow,
  handleNew,
  handleKill,
  handleHelp,
  handleHistory,
  handleStatus,
  handleConfig,
  handleWatch,
  handleClear,
  handleDedupStats,
  handleReset,
  handleConfirm,
  handleCancel,
  handleNumberSelect,
  handleSendText,
  handleExecute,
};
