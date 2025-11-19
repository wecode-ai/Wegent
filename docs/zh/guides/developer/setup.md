# 💻 开发环境搭建

本文档详细介绍如何在本地环境搭建 Wegent 开发环境。

---

## 📋 前置要求

在开始之前,请确保你的开发环境已安装以下软件:

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

---

## 🚀 快速体验

如果你只想快速体验 Wegent,可以使用 Docker Compose:

```bash
# 克隆仓库
git clone https://github.com/wecode-ai/wegent.git
cd wegent

# 启动所有服务
docker-compose up -d

# 访问 Web 界面
# http://localhost:3000
```

这将启动所有必需的服务:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API 文档**: http://localhost:8000/api/docs
- **MySQL**: localhost:3306
- **Redis**: localhost:6379
- **Executor Manager**: http://localhost:8001

---

## 🔧 本地开发环境搭建

如果你需要修改代码并进行开发,建议按以下步骤搭建本地开发环境。

### 1️⃣ 数据库配置

#### 使用 Docker 运行 MySQL

```bash
docker run -d \
  --name wegent-mysql \
  -e MYSQL_ROOT_PASSWORD=123456 \
  -e MYSQL_DATABASE=task_manager \
  -e MYSQL_USER=task_user \
  -e MYSQL_PASSWORD=task_password \
  -p 3306:3306 \
  mysql:9.4
```

#### 或者使用本地 MySQL

```bash
# 登录 MySQL
mysql -u root -p

# 创建数据库
CREATE DATABASE task_manager;

# 创建用户
CREATE USER 'task_user'@'localhost' IDENTIFIED BY 'task_password';

# 授予权限
GRANT ALL PRIVILEGES ON task_manager.* TO 'task_user'@'localhost';
FLUSH PRIVILEGES;
```

> **注意**: 数据库表和初始数据会在后端服务首次启动时自动创建，无需手动执行SQL脚本。

---

### 2️⃣ Redis 配置

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

---

### 3️⃣ 后端服务开发

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
# 主要配置项:
# DATABASE_URL=mysql+pymysql://task_user:task_password@localhost:3306/task_manager
# REDIS_URL=redis://127.0.0.1:6379/0
# PASSWORD_KEY=your-password-key-here
# EXECUTOR_DELETE_TASK_URL=http://localhost:8001/executor-manager/executor/delete
```

#### 运行开发服务器

```bash
# 使用 uvicorn 运行,支持热重载
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

访问 API 文档:
- Swagger UI: http://localhost:8000/api/docs
- ReDoc: http://localhost:8000/api/redoc

#### 后端目录结构

```
backend/
├── app/
│   ├── api/              # API 路由
│   ├── core/            # 核心配置
│   ├── db/              # 数据库连接
│   ├── models/          # SQLAlchemy 模型
│   ├── repository/      # 数据访问层
│   ├── schemas/         # Pydantic 模式
│   └── services/        # 业务逻辑层
├── init_data/           # YAML 初始化数据
└── requirements.txt     # Python 依赖
```

详细信息请参阅 [后端开发指南](./backend-dev.md)。

---

### 4️⃣ 前端服务开发

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
# 主要配置项:
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

访问应用: http://localhost:3000

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

详细信息请参阅 [前端开发指南](./frontend-dev.md)。

---

### 5️⃣ Executor Manager 开发

Executor Manager 负责管理和调度 Executor 容器。

#### 安装依赖

```bash
cd executor_manager

# 创建虚拟环境
python3 -m venv venv
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

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

详细信息请参阅 [Executor 开发指南](./executor-dev.md)。

---

## 📂 项目结构

完整的项目结构:

```
wegent/
├── backend/                 # FastAPI 后端服务
├── frontend/                # Next.js 前端应用
├── executor/                # 任务执行器
├── executor_manager/        # 执行器管理器
├── shared/                  # 共享代码和模型
├── docker/                  # Docker 配置
├── docs/                    # 文档
└── docker-compose.yml       # Docker Compose 配置
```

---

## 🔬 测试

Wegent 提供了全面的测试框架,覆盖所有核心模块。

### 后端测试

```bash
cd backend

# 运行所有测试
pytest

# 运行特定测试模块
pytest tests/core/

# 运行并生成覆盖率报告
pytest --cov=app --cov-report=html

# 只运行单元测试
pytest -m unit

# 只运行集成测试
pytest -m integration
```

### 前端测试

```bash
cd frontend

# 运行测试
npm test

# 运行并监视更改
npm run test:watch

# 生成覆盖率报告
npm run test:coverage
```

### Executor 和 Shared 模块测试

```bash
# Executor 测试
cd executor
pytest tests/ --cov=agents

# Executor Manager 测试
cd executor_manager
pytest tests/ --cov=executors

# Shared 工具测试
cd shared
pytest tests/ --cov=utils
```

### 完整测试指南

详细的测试框架说明、最佳实践和 CI/CD 配置，请参阅：
- 📖 [完整测试指南](./testing.md) - 测试框架文档、Fixtures、Mocking 策略等

---

## 🐛 调试技巧

### Backend 调试

```bash
# 启用详细日志
export LOG_LEVEL=DEBUG
uvicorn app.main:app --reload --log-level debug
```

### Frontend 调试

在浏览器开发者工具中查看:
- Console: JavaScript 错误和日志
- Network: API 请求和响应
- React DevTools: 组件状态和性能

### Executor 调试

```bash
# 查看容器日志
docker logs -f <executor-container-id>

# 进入容器调试
docker exec -it <executor-container-id> /bin/bash
```

---

## 📞 获取帮助

如果遇到问题:

1. 查看 [故障排查](../../troubleshooting.md) 部分
2. 搜索 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. 阅读相关文档:
   - [YAML 规范](../../reference/yaml-specification.md)
   - [核心概念](../../concepts/core-concepts.md)
4. 创建新的 Issue 并提供详细信息

---

## 🔗 相关资源

- [后端开发](./backend-dev.md) - 后端服务开发详细指南
- [前端开发](./frontend-dev.md) - 前端应用开发详细指南
- [Executor 开发](./executor-dev.md) - Executor 开发详细指南
- [测试](./testing.md) - 测试指南
- [贡献指南](../../contributing/how-to-contribute.md) - 如何为 Wegent 贡献

---

<p align="center">祝你开发愉快! 🚀</p>
