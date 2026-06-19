---
sidebar_position: 3
---

# Standalone 模式部署

## 概述

Standalone 模式是一种单机部署方案，将 Backend、主 Frontend、Wework Web、Chat Shell、Executor 和 Redis 打包在一个 Docker 镜像中运行，使用 SQLite 作为数据库。它适合快速体验和小规模可信环境，只需要 Docker 即可启动。

Standalone 启动后会自动为 `admin` 用户创建一个云设备：容器内 executor 通过 Backend 的设备 WebSocket 注册，Wework 创建编码任务时可以直接使用该设备执行任务。默认 workspace 挂载在 `/workspace`，用于保存项目目录、独立聊天工作区和 Git worktree。

由于编码任务直接在同一个 standalone 容器内执行，镜像按轻量开发环境而不是最小运行时来设计，默认包含 `ps`、`top`、`free`、`ip`、`ss`、`lsof`、`tree`、`rg` 等基础开发和排障工具。

### 适用场景

- 单机部署
- 开发测试
- 小规模可信使用
- 快速体验 Wework 编码任务

### 架构对比

| 特性 | 标准模式 | Standalone 模式 |
|------|----------|-----------------|
| 部署复杂度 | 高（多容器） | 低（单容器） |
| 资源占用 | 高 | 中 |
| 扩展性 | 好 | 有限 |
| 任务隔离 | Sandbox/云设备 | 同一 standalone 容器内执行 |
| 数据库 | MySQL | SQLite |
| Redis | 外部依赖 | 内嵌 |
| Wework | 独立桌面端或 Web | 内置 Wework Web |
| 适用场景 | 生产环境 | 开发/测试/小规模 |

## 快速开始

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```

这将自动：

1. 检查并安装 Docker（如果需要）
2. 拉取最新的 Wegent standalone 镜像
3. 创建 `wegent-data` 数据卷和 `wegent-workspace` 工作区卷
4. 映射主前端、Wework 和 Backend 端口
5. 启动容器并等待 Backend 和 Wework 就绪

启动完成后访问：

| 入口 | 地址 | 用途 |
|------|------|------|
| 主前端 | `http://localhost:3000` | Wegent 管理和通用功能 |
| Wework | `http://localhost:3001` | 创建和使用编码任务 |
| Backend API | `http://localhost:8000` | API 与 WebSocket |

### 手动运行容器

本机访问：

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 3001:3001 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000 \
  -e WEWORK_PUBLIC_BACKEND_URL=http://localhost:8000 \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

远程访问时，将 `YOUR_SERVER_IP` 替换为服务器 IP 或域名：

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 3001:3001 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://YOUR_SERVER_IP:8000 \
  -e WEWORK_PUBLIC_BACKEND_URL=http://YOUR_SERVER_IP:8000 \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

`WEWORK_PUBLIC_BACKEND_URL` 会在容器启动时写入 Wework 的 `runtime-config.js`，确保浏览器远程访问 `http://YOUR_SERVER_IP:3001` 时仍然连接服务器上的 Backend，而不是用户本机的 `localhost`。

## 使用 Wework 创建编码任务

1. 打开 `http://localhost:3001`（远程部署使用服务器地址）。
2. 使用初始化账号登录，或按页面提示完成账号配置。
3. 在设置中配置可用模型和 provider token。
4. 回到 Wework 工作台，直接发起一个编码请求。
5. 未选择项目时，Wework 会把请求路由到 standalone 自动注册的云设备，并在 `/workspace/chats` 下创建独立聊天工作区。
6. 创建 Git 项目后，新任务会使用 `/workspace/projects` 和 `/workspace/worktrees` 下的项目/任务工作区。
7. 需要查看文件或打开终端时，使用 Wework 项目工具栏；终端会通过登录后的 Backend Socket.IO 通道转发到容器内 executor，由 executor 直接管理 PTY。

Standalone 默认不内置 IDE/code-server 入口。正式使用时建议先将 Wework 编码、workspace 文件、项目终端作为主要能力；需要 IDE 或更强隔离时使用标准部署或单独云设备。

## 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `RUNTIME_SOCKET_DIRECT_URL` | 主 Frontend 使用的 Backend WebSocket 地址 | `http://localhost:8000` |
| `WEWORK_PUBLIC_BACKEND_URL` | Wework Web 运行时 Backend 地址，会派生 API 和 Socket 地址 | `http://localhost:8000` |
| `WEWORK_PUBLIC_API_URL` | Wework Web API 地址；设置后覆盖 `WEWORK_PUBLIC_BACKEND_URL/api` | `${WEWORK_PUBLIC_BACKEND_URL}/api` |
| `WEWORK_PUBLIC_SOCKET_URL` | Wework Web Socket.IO 地址；设置后覆盖 `WEWORK_PUBLIC_BACKEND_URL` | `${WEWORK_PUBLIC_BACKEND_URL}` |
| `WEGENT_WORKSPACE_ROOT` | standalone workspace 根目录 | `/workspace` |
| `WEWORK_PORT` | Wework Web 容器内端口 | `3001` |
| `STANDALONE_MODE` | 启用 standalone 模式 | `true` |
| `DATABASE_URL` | 数据库连接地址 | `sqlite:////app/data/wegent.db` |
| `REDIS_URL` | Redis 连接地址 | `redis://localhost:6379/0` |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | - |
| `OPENAI_API_KEY` | OpenAI API 密钥 | - |

### 数据持久化

服务状态存储在 `/app/data`：

- `wegent.db`：SQLite 数据库文件
- `redis/`：Redis 持久化数据（AOF 和 RDB）
- `standalone_executor_token`：standalone executor 注册用的 admin API key
- `standalone-executor/`：executor 本地状态

workspace 存储在 `/workspace`：

- `projects/`：Wework Git 项目目录
- `chats/`：未选择项目的独立聊天工作区
- `worktrees/`：按任务创建的 Git worktree

使用 Docker volume 持久化：

```bash
docker volume create wegent-data
docker volume create wegent-workspace

docker run \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  ...
```

## 常用命令

```bash
# 查看日志
docker logs -f wegent-standalone

# 停止容器
docker stop wegent-standalone

# 启动容器
docker start wegent-standalone

# 重启容器
docker restart wegent-standalone

# 删除容器（数据和 workspace 保留在卷中）
docker rm -f wegent-standalone

# 更新到最新版本
docker pull ghcr.io/wecode-ai/wegent-standalone:latest
docker rm -f wegent-standalone
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 3001:3001 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  -v wegent-workspace:/workspace \
  -e RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000 \
  -e WEWORK_PUBLIC_BACKEND_URL=http://localhost:8000 \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

## 构建镜像

如果需要自行构建镜像：

```bash
# 使用构建脚本
./scripts/build-standalone.sh

# 指定标签
./scripts/build-standalone.sh -t my-registry/wegent:v1.0

# 指定平台
./scripts/build-standalone.sh -p linux/amd64
```

## 注意事项

### SQLite 限制

1. **并发写入**：SQLite 不适合高并发写入，建议用于单用户或小规模使用
2. **数据备份**：定期备份 `/app/data/wegent.db` 和 `/workspace`

### 内嵌 Redis

Standalone 镜像包含内嵌 Redis：

- 数据持久化到 `/app/data/redis/`
- 使用 AOF（Append Only File）保证数据持久性
- 内存限制为 256MB，使用 LRU 淘汰策略

### Standalone Executor 限制

1. **资源隔离**：编码任务在同一 standalone 容器内执行，不具备每任务 Docker sandbox 隔离
2. **安全性**：适合可信环境，不建议执行不可信代码
3. **能力范围**：默认支持 Wework 编码任务和终端；IDE/code-server 不作为 standalone 默认能力

## 从 Standalone 迁移到标准模式

如果需要迁移到标准模式：

1. 导出 SQLite 数据
2. 备份 `/workspace` 中的项目和 worktree
3. 导入数据到 MySQL
4. 修改配置使用标准部署或独立云设备
