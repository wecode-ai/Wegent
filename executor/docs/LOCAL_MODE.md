# Executor Local Mode

Executor 本地模式允许在用户本地机器上运行任务执行器，通过 WebSocket 与 Backend 通信，无需 Docker 环境。

## 目录结构

本地模式运行时会在用户目录下创建以下结构：

```
~/.wegent-executor/                     # 主目录 (WEGENT_EXECUTOR_HOME)
├── workspace/                          # 工作区，代码仓库克隆位置
│   └── {task_id}/{repo_name}/
├── logs/
│   ├── executor.log                    # 当前日志
│   ├── executor.log.1                  # 轮转日志
│   └── executor.log.2
└── cache/
    └── skills/                         # Skills 缓存 (Claude Code)
```

## 快速开始

### 1. 开发模式运行（推荐）

从项目根目录运行，确保 `shared` 模块可以被正确导入：

```bash
cd /path/to/Wegent  # 项目根目录

# 使用环境变量或 device-config.json 中的配置运行
PYTHONPATH=. \
executor/.venv/bin/python executor/main.py
```

如果需要临时覆盖配置文件中的连接信息，可以传入环境变量：

```bash
cd /path/to/Wegent && \
PYTHONPATH=. WEGENT_BACKEND_URL=http://localhost:8000 \
WEGENT_AUTH_TOKEN=your-auth-token executor/.venv/bin/python executor/main.py
```

### 2. 构建二进制

```bash
cd executor

# 安装构建依赖
uv sync --group build

# 构建二进制
uv run python scripts/build_local.py

# 输出位置
ls -la dist/wegent-executor
```

构建产物：

- macOS: `dist/wegent-executor` (当前架构: Intel 或 Apple Silicon)
- Linux: `dist/wegent-executor`
- Windows: `dist/wegent-executor.exe`

### 3. 运行二进制

```bash
# 方式 1: 直接运行，使用环境变量或 device-config.json 中的配置
./dist/wegent-executor

# 方式 2: 临时覆盖 device-config.json 中的连接配置
WEGENT_BACKEND_URL=http://localhost:8000 \
WEGENT_AUTH_TOKEN=your-auth-token \
./dist/wegent-executor
```

### 4. 安装二进制

```bash
# 用户级安装
mkdir -p ~/.wegent-executor/bin
cp dist/wegent-executor ~/.wegent-executor/bin/

# 添加到 PATH (在 ~/.bashrc 或 ~/.zshrc 中)
export PATH="$HOME/.wegent-executor/bin:$PATH"

# 或者系统级安装
sudo cp dist/wegent-executor /usr/local/bin/
```

## 配置项

### 连接配置

Local Executor 的配置优先级是：环境变量、`~/.wegent-executor/device-config.json`、默认值。`EXECUTOR_MODE`、`WEGENT_BACKEND_URL` 和 `WEGENT_AUTH_TOKEN` 都是可选环境变量；设置后分别覆盖配置文件中的 `mode`、`connection.backend_url` 和 `connection.auth_token`。

| 配置 | 说明 | 示例 |
|------|------|------|
| `mode` / `EXECUTOR_MODE` | executor 运行模式 | `local` |
| `connection.backend_url` / `WEGENT_BACKEND_URL` | Backend 服务地址 | `http://localhost:8000` |
| `connection.auth_token` / `WEGENT_AUTH_TOKEN` | WebSocket 认证 Token 或 API Key | `your-auth-token` |

### 可选配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `WEGENT_EXECUTOR_HOME` | `~/.wegent-executor` | 主配置目录 |
| `LOCAL_WORKSPACE_ROOT` | `~/.wegent-executor/workspace` | 工作区目录 |
| `WEGENT_EXECUTOR_LOG_DIR` | `~/.wegent-executor/logs` | 日志目录 |
| `WEGENT_EXECUTOR_LOG_FILE` | `executor.log` | 日志文件名 |
| `WEGENT_EXECUTOR_LOG_MAX_SIZE` | `10` (MB) | 单个日志最大大小 |
| `WEGENT_EXECUTOR_LOG_BACKUP_COUNT` | `5` | 保留历史日志数量 |
| `LOG_LEVEL` | `INFO` | 日志级别 (`DEBUG` / `INFO`) |

### 心跳配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `LOCAL_HEARTBEAT_INTERVAL` | `30` (秒) | 心跳发送间隔 |
| `LOCAL_HEARTBEAT_TIMEOUT` | `90` (秒) | 心跳超时时间 |
| `LOCAL_RECONNECT_DELAY` | `1` (秒) | 重连初始延迟 |
| `LOCAL_RECONNECT_MAX_DELAY` | `30` (秒) | 重连最大延迟 |

### Claude Code 相关配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `ANTHROPIC_API_KEY` | - | Anthropic API Key |
| `SKILL_CLEAR_CACHE` | `true` | 是否清理 Skills 缓存 |

## 测试

### 运行单元测试

```bash
cd executor
uv run pytest tests/ -v
```

### 端到端测试

需要先启动 Backend 和 Local Executor：

```bash
# Terminal 1: 启动 Backend
cd backend && uv run uvicorn app.main:app --port 8000

# Terminal 2: 启动 Local Executor
cd executor
uv run python -m executor.main

# Terminal 3: 运行测试脚本
cd executor
uv run python scripts/test_local_executor.py

# 或者带自定义 prompt
ANTHROPIC_API_KEY=your-key \
uv run python scripts/test_local_executor.py \
    --prompt "Write a hello world function in Python"
```

测试脚本选项：

| 参数 | 说明 |
|------|------|
| `--prompt` | 自定义任务 prompt |
| `--backend-url` | Backend 地址 (默认从 `WEGENT_BACKEND_URL` 读取) |
| `--timeout` | 监控超时时间 (默认 60 秒) |
| `--skip-dispatch` | 仅检查状态，不派发任务 |

## 日志

### 查看日志

```bash
# 查看最新日志
tail -f ~/.wegent-executor/logs/executor.log

# 查看所有日志文件
ls -la ~/.wegent-executor/logs/

# 搜索错误
grep -i error ~/.wegent-executor/logs/executor.log
```

### 日志格式

```
2026-01-29 13:08:22 - [local_runner] - [in /path/to/runner.py:115] - INFO - Starting Local Executor Runner...
```

### 日志轮转

- 当日志文件超过 `WEGENT_EXECUTOR_LOG_MAX_SIZE` (默认 10MB) 时自动轮转
- 保留最近 `WEGENT_EXECUTOR_LOG_BACKUP_COUNT` (默认 5) 个历史日志
- 历史日志命名: `executor.log.1`, `executor.log.2`, ...

## 架构

```
┌──────────────────┐          WebSocket          ┌──────────────────┐
│                  │  ◄─────────────────────────►│                  │
│  Local Executor  │   local:task:dispatch       │     Backend      │
│                  │   local:task:progress       │                  │
│  (wegent-executor)│   local:chat:*              │  (FastAPI)       │
│                  │   local:executor:heartbeat  │                  │
└──────────────────┘                             └──────────────────┘
        │
        ▼
┌──────────────────┐
│  Claude Code     │
│  Agent           │
└──────────────────┘
```

### 组件说明

| 组件 | 文件 | 说明 |
|------|------|------|
| LocalRunner | `modes/local/runner.py` | 主运行器，管理生命周期 |
| WebSocketClient | `modes/local/websocket_client.py` | Socket.IO 客户端 |
| HeartbeatService | `modes/local/heartbeat.py` | 心跳服务 |
| TaskHandler | `modes/local/handlers.py` | 任务事件处理 |
| ProgressReporter | `modes/local/progress_reporter.py` | 进度上报 |

## 故障排除

### 连接失败

```
Failed to connect to Backend WebSocket
```

检查：
1. Backend 是否已启动: `curl http://localhost:8000/`
2. `device-config.json` 或 `WEGENT_BACKEND_URL` 是否正确 (应为 `http://`, 不是 `wss://`)
3. `device-config.json` 或 `WEGENT_AUTH_TOKEN` 是否包含有效认证信息

### 任务执行失败

```
Agent initialization failed
```

检查：
1. `ANTHROPIC_API_KEY` 是否设置
2. 网络是否能访问 Anthropic API

### 日志目录权限

```
Failed to setup file logging
```

检查：
1. `~/.wegent-executor/logs/` 目录是否有写权限
2. 磁盘空间是否充足

## 与 Docker 模式对比

| 特性 | Local Mode | Docker Mode |
|------|------------|-------------|
| 部署方式 | 二进制文件 | Docker 容器 |
| 通信方式 | WebSocket | HTTP Callback |
| 代码隔离 | 无 | 容器隔离 |
| 适用场景 | 开发测试、个人使用 | 生产环境 |
| 依赖 | Claude Code CLI | Docker |
