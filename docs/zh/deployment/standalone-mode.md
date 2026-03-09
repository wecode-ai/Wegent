---
sidebar_position: 3
---

# Standalone 模式部署

## 概述

Standalone 模式是一种单机部署方案，将 Backend、Frontend、Chat Shell 和 Executor 打包在一个 Docker 镜像中运行，使用 SQLite 替代 MySQL，Redis 作为外部依赖。

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
| 适用场景 | 生产环境 | 开发/测试/小规模 |

## 快速开始

### 使用 Docker Compose（推荐）

```bash
# 克隆仓库
git clone https://github.com/wecode-ai/wegent.git
cd wegent

# 启动服务
docker-compose -f docker-compose.standalone.yml up -d

# 查看日志
docker-compose -f docker-compose.standalone.yml logs -f
```

### 单独运行容器

如果你已有 Redis 服务：

```bash
docker run -d \
  --name wegent \
  -p 3000:3000 \
  -p 8000:8000 \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  -v wegent-data:/app/data \
  ghcr.io/wecode-ai/wegent-standalone:latest
```

## 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `REDIS_URL` | Redis 连接地址 | `redis://redis:6379/0` |
| `STANDALONE_MODE` | 启用 standalone 模式 | `true` |
| `DATABASE_URL` | 数据库连接地址 | `sqlite:///./data/wegent.db` |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | - |
| `OPENAI_API_KEY` | OpenAI API 密钥 | - |

### 数据持久化

数据存储在 `/app/data` 目录，包括：
- `wegent.db` - SQLite 数据库文件
- 其他运行时数据

使用 Docker volume 持久化：

```bash
docker run -v wegent-data:/app/data ...
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

### 进程内 Executor 限制

1. **资源隔离**：没有 Docker 容器隔离，任务共享进程资源
2. **安全性**：代码执行没有沙箱保护
3. **适用场景**：仅适合可信环境和开发测试

### Redis 依赖

Standalone 模式仍然需要 Redis 用于：
- 分布式锁
- 会话管理
- 任务队列
- 缓存

## 从 Standalone 迁移到标准模式

如果需要迁移到标准模式：

1. 导出 SQLite 数据
2. 导入到 MySQL
3. 修改配置使用标准部署

详细迁移指南请参考 [数据迁移文档](./data-migration.md)。
