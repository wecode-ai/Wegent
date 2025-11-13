<!--
SPDX-FileCopyrightText: 2025 Weibo, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Wegent 开发指南

本文档详细介绍如何在本地环境搭建 Wegent 开发环境，包括各个服务组件的配置和运行方法。

## 目录

- [前置要求](#前置要求)
- [快速开始](#快速开始)
- [本地开发环境搭建](#本地开发环境搭建)
  - [1. 数据库配置](#1-数据库配置)
  - [2. Redis 配置](#2-redis-配置)
  - [3. 后端服务开发](#3-后端服务开发)
  - [4. 前端服务开发](#4-前端服务开发)
  - [5. Executor Manager 开发](#5-executor-manager-开发)
  - [6. Executor 开发](#6-executor-开发)
- [项目结构](#项目结构)
- [开发工作流](#开发工作流)
- [测试](#测试)
- [常见问题](#常见问题)

## 前置要求

在开始之前，请确保你的开发环境已安装以下软件：

### 必需软件

- **Python 3.9+**: 后端服务、Executor 和 Executor Manager
- **Node.js 18+**: 前端开发
- **MySQL 8.0+**: 数据库服务
- **Redis 7+**: 缓存服务
- **Docker & Docker Compose**: 容器化部署和开发
- **Git**: 版本控制

### 推荐工具

- **Visual Studio Code**: 代码编辑器
- **Postman** 或 **curl**: API 测试
- **MySQL Workbench**: 数据库管理

## 快速开始

如果你只想快速体验 Wegent，可以使用 Docker Compose：

```bash
# 克隆仓库
git clone https://github.com/wecode-ai/wegent.git
cd wegent

# 启动所有服务
docker-compose up -d

# 访问 Web 界面
# http://localhost:3000
```

这将启动所有必需的服务：
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API 文档**: http://localhost:8000/api/docs
- **MySQL**: localhost:3306
- **Redis**: localhost:6379
- **Executor Manager**: http://localhost:8001

## 本地开发环境搭建

如果你需要修改代码并进行开发，建议按以下步骤搭建本地开发环境。

### 1. 数据库配置

#### 使用 Docker 运行 MySQL

```bash
docker run -d \
  --name wegent-mysql \
  -e MYSQL_ROOT_[INFORMATION_DATA_ID_03]=123456 \
  -e MYSQL_DATABASE=task_manager \
  -e MYSQL_USER=task_user \
  -e MYSQL_[INFORMATION_DATA_ID_03]=task_[INFORMATION_DATA_ID_04] \
  -p 3306:3306 \
  mysql:9.4
```

#### 或者使用本地 MySQL

如果你已经有本地 MySQL 实例：

```bash
# 登录 MySQL
mysql -u root -p

# 创建数据库
CREATE DATABASE task_manager;

# 创建用户
CREATE USER 'task_user'@'localhost' IDENTIFIED BY 'task_[INFORMATION_DATA_ID_04]';

# 授予权限
GRANT ALL PRIVILEGES ON task_manager.* TO 'task_user'@'localhost';
FLUSH PRIVILEGES;
```

#### 初始化数据库表

```bash
cd backend
mysql -u task_user -p task_manager < init.sql
```

### 2. Redis 配置

#### 使用 Docker 运行 Redis

```bash
docker run -d \
  --name wegent-redis \
  -p 6379:6379 \
  redis:7
```

#### 或者使用本地 Redis

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis

# 验证 Redis 运行
redis-cli ping
# 应返回 PONG
```

### 3. 后端服务开发

后端服务是基于 FastAPI 的 RESTful API 服务。

#### 安装依赖

```bash
cd backend

# 创建虚拟环境
python3 -m venv venv

# 激活虚拟环境
# macOS/Linux:
source venv/bin/activate
# Windows:
# venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

#### 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件
# 主要配置项：
# DATABASE_URL=mysql+pymysql://task_user:task_[INFORMATION_DATA_ID_04]@localhost:3306/task_manager
# REDIS_URL=redis://127.0.0.1:6379/0
# [INFORMATION_DATA_ID_05]_KEY=your-[INFORMATION_DATA_ID_06]-key-here
# EXECUTOR_DELETE_TASK_URL=http://localhost:8001/executor-manager/executor/delete
```

#### 运行开发服务器

```bash
# 使用 uvicorn 运行，支持热重载
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

访问 API 文档：
- Swagger UI: http://localhost:8000/api/docs
- ReDoc: http://localhost:8000/api/redoc

#### 后端目录结构

```
backend/
├── app/
│   ├── api/              # API 路由
│   │   ├── auth/        # 认证相关接口
│   │   ├── bots/        # Bot 管理接口
│   │   ├── ghosts/      # Ghost 管理接口
│   │   ├── models/      # Model 管理接口
│   │   ├── shells/      # Shell 管理接口
│   │   ├── teams/       # Team 管理接口
│   │   └── tasks/       # Task 管理接口
│   ├── core/            # 核心配置
│   ├── db/              # 数据库连接
│   ├── models/          # SQLAlchemy 模型
│   ├── repository/      # 数据访问层
│   ├── schemas/         # Pydantic 模式
│   └── services/        # 业务逻辑层
├── init.sql             # 数据库初始化脚本
└── requirements.txt     # Python 依赖
```

### 4. 前端服务开发

前端是基于 Next.js 15 的 React 应用。

#### 安装依赖

```bash
cd frontend

# 安装 npm 依赖
npm install
```

#### 配置环境变量

```bash
# 复制环境变量模板
cp .env.local.example .env.local

# 编辑 .env.local 文件
# 主要配置项：
# NEXT_PUBLIC_API_URL=http://localhost:8000
# NEXT_PUBLIC_USE_MOCK_API=false
# NEXT_PUBLIC_LOGIN_MODE=all
# I18N_LNG=zh-CN
```

#### 运行开发服务器

```bash
# 启动开发服务器
npm run dev
```

访问应用：http://localhost:3000

#### 其他命令

```bash
# 代码检查
npm run lint

# 代码格式化
npm run format

# 生产构建
npm run build

# 运行生产版本
npm run start
```

#### 前端目录结构

```
frontend/
├── src/
│   ├── app/             # Next.js 应用路由
│   ├── components/      # React 组件
│   ├── contexts/        # React Context
│   ├── hooks/           # 自定义 Hooks
│   ├── services/        # API 服务
│   ├── types/           # TypeScript 类型定义
│   └── utils/           # 工具函数
├── public/              # 静态资源
└── package.json         # npm 依赖
```

### 5. Executor Manager 开发

Executor Manager 负责管理和调度 Executor 容器。

#### 安装依赖

```bash
cd executor_manager

# 创建虚拟环境
python3 -m venv venv

# 激活虚拟环境
source venv/bin/activate  # Windows: venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

#### 配置环境变量

主要环境变量：
- `TASK_API_DOMAIN`: Backend API 地址（默认: http://backend:8000）
- `MAX_CONCURRENT_TASKS`: 最大并发任务数（默认: 5）
- `PORT`: 服务端口（默认: 8001）
- `CALLBACK_HOST`: 回调地址（默认: http://executor_manager:8001）
- `NETWORK`: Docker 网络名称（默认: wegent-network）
- `EXECUTOR_IMAGE`: Executor 镜像名称
- `EXECUTOR_PORT_RANGE_MIN`: Executor 端口范围最小值（默认: 10001）
- `EXECUTOR_PORT_RANGE_MAX`: Executor 端口范围最大值（默认: 10100）
- `EXECUTOR_WORKSPCE`: Executor 工作空间路径

#### 运行开发服务器

```bash
# 设置环境变量
export TASK_API_DOMAIN=http://localhost:8000
export CALLBACK_HOST=http://localhost:8001
export MAX_CONCURRENT_TASKS=5
export EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:1.0.2
export EXECUTOR_WORKSPCE=${HOME}/wecode-bot

# 运行服务
python main.py
```

#### Executor Manager 目录结构

```
executor_manager/
├── clients/             # API 客户端
├── config/              # 配置管理
├── executors/           # Executor 管理逻辑
├── github/              # GitHub 集成
├── routers/             # API 路由
├── scheduler/           # 任务调度
├── tasks/               # 任务管理
├── utils/               # 工具函数
└── main.py              # 入口文件
```

### 6. Executor 开发

Executor 是实际执行 AI 任务的容器化服务。

#### 安装依赖

```bash
cd executor

# 创建虚拟环境
python3 -m venv venv

# 激活虚拟环境
source venv/bin/activate  # Windows: venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

#### 支持的 Agent 类型

Executor 目前支持以下 Agent：

1. **Claude Code**: 基于 Claude Agent SDK
2. **Agno**: 基于 Agno 框架（实验性）

#### 配置 Agent

每个 Agent 需要不同的环境变量配置：

**Claude Code Agent:**
```bash
export ANTHROPIC_MODEL=openrouter,anthropic/claude-sonnet-4
export ANTHROPIC_AUTH_TOKEN=sk-xxxxxx
export ANTHROPIC_BASE_URL=http://xxxxx
export ANTHROPIC_SMALL_FAST_MODEL=openrouter,anthropic/claude-3.5-haiku
```

**Agno Agent:**
```bash
# 配置待补充
```

#### 运行 Executor（本地测试）

```bash
# 设置必要的环境变量
export WORKSPACE_PATH=/path/to/workspace
export CALLBACK_URL=http://localhost:8001/callback

# 运行服务
uvicorn main:app --host 0.0.0.0 --port 10001 --reload
```

#### Executor 目录结构

```
executor/
├── agents/              # Agent 实现
│   ├── claude_code/    # Claude Code Agent
│   ├── agno/           # Agno Agent
│   ├── base.py         # Agent 基类
│   └── factory.py      # Agent 工厂
├── callback/            # 回调处理
├── config/              # 配置管理
├── services/            # 服务层
├── tasks/               # 任务处理
├── utils/               # 工具函数
└── main.py              # 入口文件
```

## 项目结构

完整的项目结构：

```
wegent/
├── backend/                 # FastAPI 后端服务
│   ├── app/                # 应用代码
│   ├── init.sql            # 数据库初始化
│   └── requirements.txt    # Python 依赖
├── frontend/                # Next.js 前端应用
│   ├── src/                # 源代码
│   ├── public/             # 静态资源
│   └── package.json        # npm 依赖
├── executor/                # 任务执行器
│   ├── agents/             # Agent 实现
│   └── requirements.txt    # Python 依赖
├── executor_manager/        # 执行器管理器
│   ├── executors/          # Executor 管理
│   └── requirements.txt    # Python 依赖
├── shared/                  # 共享代码和模型
├── docker/                  # Docker 配置
│   ├── backend/            # Backend Dockerfile
│   ├── frontend/           # Frontend Dockerfile
│   ├── executor/           # Executor Dockerfile
│   └── executor_manager/   # Executor Manager Dockerfile
├── docs/                    # 文档
│   ├── zh/                 # 中文文档
│   └── en/                 # 英文文档
├── docker-compose.yml       # Docker Compose 配置
└── README.md               # 项目说明
```

## 开发工作流

### 1. 创建功能分支

```bash
# 从主分支创建新分支
git checkout -b feature/your-feature-name

# 或者从开发分支创建
git checkout develop
git checkout -b feature/your-feature-name
```

### 2. 进行开发

- 遵循代码规范和最佳实践
- 编写清晰的提交信息
- 保持代码简洁和可维护性

### 3. 运行测试

```bash
# Backend 测试
cd backend
python -m pytest

# Frontend 测试
cd frontend
npm test
```

### 4. 提交代码

```bash
# 添加更改
git add .

# 提交更改
git commit -m "feat: add new feature"

# 推送到远程
git push origin feature/your-feature-name
```

### 5. 创建 Pull Request

在 GitHub 或 GitLab 上创建 Pull Request，等待代码审查。

## 测试

### 后端测试

```bash
cd backend

# 运行所有测试
python -m pytest

# 运行特定测试文件
python -m pytest tests/test_auth.py

# 运行并生成覆盖率报告
python -m pytest --cov=app --cov-report=html
```

### 前端测试

```bash
cd frontend

# 运行测试
npm test

# 运行并监视更改
npm test -- --watch

# 生成覆盖率报告
npm test -- --coverage
```

### 集成测试

```bash
# 使用 docker-compose 运行完整环境
docker-compose up -d

# 运行集成测试脚本
# TODO: 添加集成测试脚本
```

## 常见问题

### 1. 数据库连接失败

**问题**: `sqlalchemy.exc.OperationalError: (pymysql.err.OperationalError) (2003, "Can't connect to MySQL server")`

**解决方案**:
- 确保 MySQL 服务正在运行
- 检查 `DATABASE_URL` 配置是否正确
- 确认数据库用户权限

### 2. Redis 连接失败

**问题**: `redis.exceptions.ConnectionError: Error connecting to Redis`

**解决方案**:
- 确保 Redis 服务正在运行
- 检查 `REDIS_URL` 配置
- 验证 Redis 端口是否被占用

### 3. 前端无法连接后端

**问题**: API 请求失败，CORS 错误

**解决方案**:
- 确保后端服务正在运行
- 检查 `NEXT_PUBLIC_API_URL` 配置
- 确认后端 CORS 配置正确

### 4. Executor 启动失败

**问题**: Executor 容器无法启动或立即退出

**解决方案**:
- 检查 Docker 是否正在运行
- 确认 Executor Manager 配置正确
- 查看容器日志: `docker logs <container-id>`
- 确保必要的环境变量已设置

### 5. 端口冲突

**问题**: `Address already in use`

**解决方案**:
```bash
# 查找占用端口的进程
lsof -i :8000  # 或其他端口

# 终止进程
kill -9 <PID>

# 或修改服务端口配置
```

### 6. Python 依赖安装失败

**问题**: `pip install` 失败

**解决方案**:
```bash
# 升级 pip
pip install --upgrade pip

# 使用国内镜像源
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 或使用 conda
conda install --file requirements.txt
```

### 7. Node.js 依赖安装失败

**问题**: `npm install` 失败

**解决方案**:
```bash
# 清理缓存
npm cache clean --force

# 删除 node_modules 和 package-lock.json
rm -rf node_modules package-lock.json

# 重新安装
npm install

# 或使用 yarn
yarn install
```

### 8. Agent 无法正常工作

**问题**: Agent 执行任务时出错

**解决方案**:
- 检查 Agent 配置（如 API Key、模型名称等）
- 确认环境变量设置正确
- 查看 Executor 日志获取详细错误信息
- 验证网络连接和 API 访问权限

## 调试技巧

### Backend 调试

```bash
# 启用详细日志
export LOG_LEVEL=DEBUG
uvicorn app.main:app --reload --log-level debug
```

### Frontend 调试

在浏览器开发者工具中查看：
- Console: JavaScript 错误和日志
- Network: API 请求和响应
- React DevTools: 组件状态和性能

### Executor 调试

```bash
# 查看容器日志
docker logs -f <executor-container-id>

# 进入容器调试
docker exec -it <executor-container-id> /bin/bash

# 查看环境变量
docker exec <executor-container-id> env
```

## 获取帮助

如果遇到其他问题：

1. 查看 [常见问题](#常见问题) 部分
2. 搜索 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. 阅读相关文档：
   - [资源定义格式](资源定义格式.md)
   - [README](../../README_zh.md)
4. 创建新的 Issue 并提供详细信息

## 贡献指南

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md) 了解如何为 Wegent 项目做出贡献。

---

祝你开发愉快! 🚀
