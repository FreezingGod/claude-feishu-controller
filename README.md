# Claude Code + 飞书桥接服务

> 通过飞书远程控制 Claude Code，实时接收状态通知和消息推送

---

## 项目背景

Claude Code 是 Anthropic 官方提供的 AI 编程助手，运行在终端中。核心痛点：

1. **需要持续监控**：Claude Code 可能随时需要用户输入（确认操作、选择选项、回答问题）
2. **不能离线**：一旦离开终端，就无法及时响应
3. **消息不透明**：Claude 的回复只在终端显示，无法同步到手机

本项目通过飞书开放平台实现远程桥接，解决上述问题。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **状态监控** | 自动检测 Claude Code 的各种状态并推送飞书通知 |
| **消息同步** | 监控 transcript.jsonl 文件，实时将 Claude 的回复推送到飞书 |
| **远程交互** | 通过飞书回复确认、选择选项、发送命令 |
| **多会话** | 支持管理和切换多个 tmux 会话 |
| **命令执行** | 远程执行 Shell 命令并返回结果 |
| **安全防护** | 命令注入防护、输入验证 |

---

## 架构设计

### 整体架构图

```
┌────────────────────────────────────────────────────────────────────┐
│                         飞书 App / 网页版                           │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ WebSocket / 事件推送
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         桥接服务 (Node.js)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  │  Config  │  │ Monitor  │  │ Messenger│  │ Handlers │  │ Utils │ │
│  └──────────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┘ │
│                      │           │             │                    │
│                      └───────────┴─────────────┘                    │
│                              ▼                                     │
│                        ┌──────────┐                                │
│                        │ Router   │                                │
│                        └────┬─────┘                                │
└─────────────────────────────┼──────────────────────────────────────┘
                              │ spawn() IPC
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Tmux Server                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ claude-code  │  │ my-project   │  │ test         │             │
│  │ (Claude Code)│  │ (开发环境)   │  │ (测试环境)   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
```

### 核心模块

```
src/
├── config/              # 配置管理
│   ├── index.js         # 环境变量加载、验证、默认值
│   └── constants.js     # 常量定义（状态优先级、轮询间隔等）
│
├── tmux/                # Tmux 操作封装
│   ├── session.js       # 会话管理：list, create, kill, exists
│   └── commander.js     # 命令执行：send, capture, execute
│
├── monitor/             # Claude Code 状态监控
│   ├── patterns.js      # 正则模式定义
│   ├── detector.js      # 策略模式检测器（动态注册、优先级、冷却）
│   └── buffer.js        # 缓冲区管理
│
├── messenger/           # 消息发送
│   ├── adapter.js       # MessengerAdapter 接口定义
│   ├── feishu.js        # 飞书适配器实现
│   └── index.js         # 模块导出
│
├── handlers/            # 消息处理
│   ├── command.js       # 各命令处理器实现
│   ├── router.js        # 消息路由器（命令分发、队列、并发控制）
│   └── index.js         # 模块导出
│
├── utils/               # 工具函数
│   ├── logger.js        # 统一日志
│   ├── validator.js     # 输入验证
│   ├── deduplicator.js  # 事件去重（LRU + TTL）
│   ├── message-history.js # 消息历史去重
│   ├── async-lock.js    # 异步锁
│   └── process-manager.js # 进程管理
│
├── session-manager.js   # 会话状态管理
├── transcript-monitor.js # Transcript 文件监控
└── index.js             # 主入口
```

---

## 安装配置

### 环境要求

- Node.js >= 16.0.0
- tmux
- 飞书企业自建应用

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
cp .env.example .env
nano .env  # 或使用你喜欢的编辑器
```

完整配置示例：

```env
# ========== 飞书开放平台配置 ==========
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
USER_CHAT_ID=oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ========== 会话配置 ==========
SESSION_FILE=/tmp/claude-feishu-last-session.txt
DEFAULT_SESSION_NAME=claude-code

# ========== 监控配置 ==========
POLL_INTERVAL=2000              # 默认轮询间隔（毫秒）
BUFFER_SIZE=500                 # 每次捕获行数
MAX_BUFFER_LENGTH=50000         # 缓冲区最大长度
MIN_BUFFER_LENGTH=20000         # 清理后保留长度

# ========== 日志配置 ==========
LOG_LEVEL=info                  # debug | info | warn | error
LOG_FILE=                       # 留空则只输出到控制台
```

### 获取飞书凭证

#### 步骤 1：创建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 进入「创建企业自建应用」
3. 填写应用名称和描述，创建

#### 步骤 2：获取凭证

在应用详情页的「凭证与基础信息」中获取：
- **App ID**
- **App Secret**

#### 步骤 3：申请权限

在「权限管理」中申请以下权限：

| 权限 | 说明 |
|------|------|
| `im:message` | 接收和发送消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `im:message.group_at_msg:readonly` | 读取群组 @ 消息（可选） |

#### 步骤 4：订阅事件

在「事件订阅」中订阅：
- `im.message.receive_v1`（接收消息事件）

#### 步骤 5：获取 Chat ID

方法一：通过飞书网页版 URL
```
打开与机器人的聊天 → URL 中的 chat_id 参数
```

方法二：通过 API 调试
```bash
curl -X GET "https://open.feishu.cn/open-apis/im/v1/chats?page_size=50" \
  -H "Authorization: Bearer YOUR_APP_ACCESS_TOKEN"
```

---

## 使用方法

### 启动服务

```bash
# 前台运行（调试用）
npm start

# 后台运行（推荐）
nohup npm start >> server.log 2>&1 &

# 使用 PM2（生产环境推荐）
pm2 start src/index.js --name claude-bridge
```

### 停止服务

```bash
# 前台运行：Ctrl + C

# 后台运行
ps aux | grep "node src/index.js"
kill <PID>

# PM2
pm2 stop claude-bridge
```

### Systemd 系统服务（推荐）

#### 服务管理脚本

项目已配置为 systemd 系统服务，支持开机自启和自动重启。

使用管理脚本（推荐）：

```bash
# 启动服务
./manage.sh start

# 停止服务
./manage.sh stop

# 重启服务
./manage.sh restart

# 查看服务状态
./manage.sh status

# 查看实时日志
./manage.sh logs

# 查看错误日志
./manage.sh logs-failed
```

#### 手动 systemctl 命令

```bash
# 启动服务
sudo systemctl start claude-feishu-controller

# 停止服务
sudo systemctl stop claude-feishu-controller

# 重启服务
sudo systemctl restart claude-feishu-controller

# 查看服务状态
sudo systemctl status claude-feishu-controller

# 开机自启
sudo systemctl enable claude-feishu-controller

# 取消开机自启
sudo systemctl disable claude-feishu-controller

# 查看日志（实时）
sudo journalctl -u claude-feishu-controller -f

# 查看日志（最近100行）
sudo journalctl -u claude-feishu-controller -n 100
```

#### 服务特性

- ✅ **开机自启**：系统启动后自动运行
- ✅ **崩溃重启**：服务异常退出后自动重启（10秒延迟）
- ✅ **日志管理**：所有日志记录在 systemd journal
- ✅ **资源限制**：限制文件描述符数量为 65536
- ✅ **安全加固**：使用 PrivateTmp、ProtectSystem 等安全选项

#### 服务配置

服务文件位置：`/etc/systemd/system/claude-feishu-controller.service`

主要配置：
- 工作目录：`/home/ubuntu/projects/claude-feishu-controller`
- 运行用户：`ubuntu`
- 启动命令：`npm start`
- 重启策略：`always`（总是重启）
- 重启延迟：10 秒

### 命令参考

#### 基础交互

| 输入 | 功能 | 示例 |
|------|------|------|
| `普通文本` | 发送给 Claude Code | `帮我写一个快排` |
| `yes` / `y` | 确认操作 | `yes` |
| `no` / `n` | 取消操作 | `no` |
| `数字` | 选择选项 | `2` |
| `速速停止` | 发送 ESC 中断 | `速速停止` |

#### 桥接命令

| 命令 | 功能 | 示例 |
|------|------|------|
| `/switch` | 列出所有会话 | `/switch` |
| `/switch <名>` | 切换监控会话 | `/switch my-project` |
| `/tab <n>` | 选中单个 tab | `/tab 1` |
| `/tab <n>,<n>` | 选中多个 tab | `/tab 1,2,3` |
| `/show` | 显示当前内容 | `/show` |
| `/new <名>` | 创建新会话 | `/new test` |
| `/kill` | 杀掉当前会话 | `/kill` |
| `/history` | 查看命令历史 | `/history` |
| `/status` | 显示系统状态 | `/status` |
| `/config` | 查看当前配置 | `/config` |
| `/watch` | 实时跟随输出 | `/watch` |
| `/clear` | 清空缓冲区 | `/clear` |
| `/reset` | 清除 Claude Code context | `/reset` |
| `/dedup-stats` | 去重器统计信息 | `/dedup-stats` |
| `/help` | 显示帮助 | `/help` |

#### Shell 命令

| 命令 | 功能 | 示例 |
|------|------|------|
| `!<命令>` | 执行并返回结果 | `!pwd` |
| `!<命令>` | 执行并返回结果 | `!ls -la` |
| `!<命令>` | 执行并返回结果 | `!git status` |

---

## 工作原理

### 状态检测流程

```javascript
// 1. 定期捕获 tmux 窗格内容
const buffer = tmux.capturePane(sessionName, -500);

// 2. 按优先级检测状态
for (const detector of detectors) {
  if (detector.detect(buffer)) {
    // 3. 检查冷却时间和去重
    if (shouldTrigger(detector)) {
      // 4. 执行处理器并发送通知
      const result = detector.handler(buffer);
      messenger.sendStatus(result.type, result.content);
    }
  }
}
```

### 状态检测优先级

| 优先级 | 状态 | 触发条件 | 冷却时间 |
|--------|------|----------|----------|
| 10 | tab_selection | 检测到复选框界面 (☐) | 10s |
| 9 | exit_plan_mode | Plan Mode 完成确认 | 10s |
| 7 | asking_question | Claude 提问 | 30s |
| 6 | confirmation | 需要 yes/no 确认 | 60s |
| 2 | input_prompt | 等待输入 | 15s |

> **注意**：其他状态（如 plan_mode、testing、git_operation、warning）会被检测但**不发送飞书通知**，仅在日志中记录。

### Transcript 消息同步

Transcript 监控器会：

1. **动态项目检测**：自动检测当前 tmux 会话的工作目录，切换到对应项目
2. **智能 Session 检测**：同时检查 `.jsonl` 文件和目录，兼容 Claude Code 不同版本
3. 监控 `~/.claude/projects/{project}/{sessionId}.jsonl` 文件
4. 检测新的 assistant 消息（通过 UUID 去重）
5. 将消息内容推送到飞书
6. 支持多 subagent 文件监控
7. 持久化已处理消息，防止重启后重发

#### 工作原理

```javascript
// 1. 获取 tmux 会话的工作目录
const workingDir = await tmux.displayMessage('#{pane_current_path}');

// 2. 转换为 Claude Code 项目路径
// /home/ubuntu/wiki -> ~/.claude/projects/-home-ubuntu-projects-wiki

// 3. 查找最新的 session（文件或目录）
const sessionId = findLatestSession(projectDir);

// 4. 监控对应的 transcript 文件
watchFile(`${projectDir}/${sessionId}.jsonl`);
```

### 消息路由流程

```javascript
// MessageRouter 解析消息并分发
async route(message) {
  const content = parseMessageContent(message);

  if (content.startsWith('/')) {
    // 桥接命令 → 对应 handler
    return handleCommand(content);
  }

  if (content.startsWith('!')) {
    // Shell 命令 → 执行并返回
    return handleExecute(content);
  }

  if (isConfirmation(content)) {
    // 确认 → 发送到 Claude Code
    return handleConfirm(content);
  }

  // 其他 → 发送给 Claude Code
  return handleSendText(content);
}
```

---

## 安全特性

### 命令注入防护

```javascript
// ❌ 危险：命令注入风险
execSync(`tmux send-keys -t ${userInput} Enter`);

// ✅ 安全：参数化执行
spawn('tmux', ['send-keys', '-t', validatedSession, 'Enter']);
```

### 输入验证

```javascript
// 会话名称：只允许字母、数字、下划线、连字符和点
/^[a-zA-Z0-9_.-]+$/

// 危险命令检测
/;\s*rm\s+-rf/
/;\s*dd\s+if=/
/&&\s*rm\s+-rf/
```

### 凭证管理

- ✅ 无硬编码凭证
- ✅ 强制从环境变量读取
- ✅ 启动时验证必需配置

---

## 故障排查

### 问题：服务启动失败

```bash
# 检查 Node.js 版本
node --version  # 需要 >= 16.0.0

# 检查依赖
npm list

# 检查环境变量
cat .env
```

### 问题：飞书消息收不到

```bash
# 1. 检查凭证是否正确
# 2. 检查权限是否通过审核
# 3. 检查事件是否正确订阅
# 4. 查看服务日志
tail -f server.log
```

### 问题：状态检测不准确

```bash
# 1. 使用 /show 查看实际捕获的内容
# 2. 调整 BUFFER_SIZE 增加捕获行数
# 3. 调整 POLL_INTERVAL 改变检测频率
```

### 问题：tmux 会话连接失败

```bash
# 检查 tmux 是否运行
tmux list-sessions

# 检查会话名称
tmux list-sessions -F "#{session_name}"

# 创建测试会话
tmux new-session -d -s test
```

### 问题：Systemd 服务无法启动

```bash
# 检查服务状态
sudo systemctl status claude-feishu-controller

# 查看详细日志
sudo journalctl -u claude-feishu-controller -n 50 --no-pager

# 检查服务文件
sudo cat /etc/systemd/system/claude-feishu-controller.service

# 重载 systemd 配置
sudo systemctl daemon-reload

# 重启服务
sudo systemctl restart claude-feishu-controller
```

### 问题：服务频繁重启

```bash
# 查看重启历史
sudo journalctl -u claude-feishu-controller --grep="restarted" -n 20

# 查看错误日志
sudo journalctl -u claude-feishu-controller -p err -n 50

# 临时禁用自动重启调试
# 编辑服务文件，将 Restart=always 改为 Restart=no
# 然后重载并重启
sudo systemctl daemon-reload
sudo systemctl restart claude-feishu-controller
```

---

## 开发指南

### 添加新状态检测器

```javascript
// 1. 在 src/monitor/patterns.js 中添加模式
export const CUSTOM_PATTERNS = [
  /custom pattern/i,
  'another pattern',
];

export function detectCustom(buffer) {
  return CUSTOM_PATTERNS.some(p =>
    buffer.match(p) || buffer.includes(p)
  );
}

// 2. 在 src/monitor/detector.js 中注册
this.register({
  name: 'custom_state',
  priority: 5,
  cooldown: 10000,
  detect: (buffer) => patterns.detectCustom(buffer),
  handler: (buffer) => ({
    type: 'custom_state',
    content: buffer.slice(-1000),
  }),
});
```

### 添加新命令

```javascript
// 1. 在 src/handlers/command.js 中实现
export async function handleCustomCommand(ctx, args) {
  // ctx 提供的属性：
  // - messenger: 发送消息
  // - commander: 执行 tmux 命令
  // - currentSession: 当前会话
  // - sessionManager: 会话管理

  await ctx.sendText(`执行自定义命令: ${args}`);
}

// 2. 在 src/handlers/router.js 中注册
this.commandHandlers.set('custom', (args) =>
  commands.handleCustomCommand(this.context, args)
);
```

### 调试技巧

```javascript
// 启用调试日志
LOG_LEVEL=debug npm start

// 查看捕获的内容
// 在飞书发送: /show

// 查看当前状态
// 在飞书发送: /status

// 查看配置
// 在飞书发送: /config
```

---

## 设计取舍

### 1. 通信方式：WebSocket vs Webhook

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| WebSocket | 实时性好，无需公网 IP | 需要保持长连接 | ✅ 采用 |
| Webhook | 部署简单 | 需要公网 IP，有延迟 | - |

**取舍理由**：本项目运行在内网服务器，无公网 IP，WebSocket 更合适。

### 2. 命令执行：spawn() vs execSync()

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| spawn() | 参数化执行，防注入 | 代码稍复杂 | ✅ 采用 |
| execSync() | 代码简单 | 命令注入风险 | - |

**取舍理由**：安全性优先，用户输入不可信。

### 3. 状态检测：策略模式 vs if-else

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 策略模式 | 易扩展，解耦 | 代码量稍多 | ✅ 采用 |
| if-else | 简单直接 | 难维护，紧耦合 | - |

**取舍理由**：需要支持 10+ 种状态，策略模式更易维护和扩展。

### 4. 轮询频率：固定 vs 动态

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 动态调整 | 节省资源，响应及时 | 实现复杂 | ✅ 采用 |
| 固定频率 | 简单 | 浪费资源或响应慢 | - |

**取舍理由**：不同状态下对响应速度的要求不同。

| 状态 | 轮询间隔 | 理由 |
|------|----------|------|
| 执行中 | 5 秒 | 不需要及时响应 |
| 空闲 | 10 秒 | 减少资源消耗 |
| 等待输入 | 1 秒 | 需要快速响应 |
| 默认 | 2 秒 | 平衡点 |

---

## 许可证

MIT License

