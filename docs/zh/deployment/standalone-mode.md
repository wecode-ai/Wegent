---
sidebar_position: 3
---

# Standalone 模式部署

## 概述

Standalone 模式是一种单机部署方案，将 Backend、Frontend、Chat Shell、Executor 和 Redis 打包在一个 Docker 镜像中运行，使用 SQLite 作为数据库。无需任何外部依赖，只需要 Docker 即可运行。

### 适用场景

- 单机部署
- 开发测试
- 小规模使用
- 快速体验

### 架构对比

| 特性 | 标准模式 | Standalone 模式 |
|------|----------|-----------------|
| 部署复杂度 | 高（多容器） | 低（单容器） |
| 资源占用 | 高 | 中 |
| 扩展性 | 好 | 有限 |
| 隔离性 | 好（Docker） | 无 |
| 数据库 | MySQL | SQLite |
| Redis | 外部依赖 | 内嵌 |
| 适用场景 | 生产环境 | 开发/测试/小规模 |

## 快速开始

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```

这将自动：
1. 检查并安装 Docker（如果需要）
2. 拉取最新的 Wegent standalone 镜像
3. 创建数据卷用于持久化
4. 启动容器

### 手动运行容器

如果你更喜欢手动运行：

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

如需远程访问（将 `YOUR_SERVER_IP` 替换为你的实际 IP）：

```bash
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  -e RUNTIME_SOCKET_DIRECT_URL=http://YOUR_SERVER_IP:8000 \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

## 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `RUNTIME_SOCKET_DIRECT_URL` | 前端 WebSocket 连接地址 | `http://localhost:8000` |
| `STANDALONE_MODE` | 启用 standalone 模式 | `true` |
| `DATABASE_URL` | 数据库连接地址 | `sqlite:////app/data/wegent.db` |
| `REDIS_URL` | Redis 连接地址 | `redis://localhost:6379/0` |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | - |
| `OPENAI_API_KEY` | OpenAI API 密钥 | - |

### 数据持久化

数据存储在 `/app/data` 目录，包括：
- `wegent.db` - SQLite 数据库文件
- `redis/` - Redis 持久化数据（AOF 和 RDB）
- 其他运行时数据

使用 Docker volume 持久化：

```bash
# 创建命名卷
docker volume create wegent-data

# 使用该卷运行
docker run -v wegent-data:/app/data ...
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

# 删除容器（数据保留在卷中）
docker rm -f wegent-standalone

# 更新到最新版本
docker pull ghcr.io/wecode-ai/wegent-standalone:latest
docker rm -f wegent-standalone
docker run -d \
  --name wegent-standalone \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 8000:8000 \
  -v wegent-data:/app/data \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

## 构建镜像

如果需要自行构建镜像：

```bash
# 使用构建脚本
./scripts/build-standalone.sh

# 或指定标签
./scripts/build-standalone.sh -t my-registry/wegent:v1.0

# 指定平台
./scripts/build-standalone.sh -p linux/amd64
```

## 注意事项

### SQLite 限制

1. **并发写入**：SQLite 不支持高并发写入，适合单用户或小规模使用
2. **数据备份**：定期备份 `/app/data/wegent.db` 文件

### 内嵌 Redis

Standalone 镜像包含内嵌的 Redis 服务：
- 数据持久化到 `/app/data/redis/`
- 使用 AOF（Append Only File）保证数据持久性
- 内存限制：256MB，使用 LRU 淘汰策略

### 进程内 Executor 限制

1. **资源隔离**：没有 Docker 容器隔离，任务共享进程资源
2. **安全性**：代码执行没有沙箱保护
3. **适用场景**：仅适合可信环境和开发测试

## 从 Standalone 迁移到标准模式

如果需要迁移到标准模式：

1. 导出 SQLite 数据
2. 导入到 MySQL
3. 修改配置使用标准部署

详细迁移指南请参考 [数据迁移文档](./data-migration.md)。
