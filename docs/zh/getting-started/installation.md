---
sidebar_position: 2
---

# 📦 详细安装指南

本指南提供了 Wegent 平台的详细安装配置说明，包括系统要求、安装步骤和配置选项。

---

## 📋 系统要求

### 硬件要求

| 组件     | 最低要求         | 推荐配置     |
| -------- | ---------------- | ------------ |
| **CPU**  | 2 核             | 4 核或更多   |
| **内存** | 4 GB             | 8 GB 或更多  |
| **存储** | 20 GB            | 50 GB 或更多 |
| **网络** | 稳定的互联网连接 | -            |

### 软件要求

#### 必需软件

- **Docker**: 20.10+
- **Docker Compose**: 2.0+
- **Git**: 2.0+

#### 可选软件（用于开发）

- **Python**: 3.10+
- **Node.js**: 18+
- **MySQL**: 8.0+
- **Redis**: 7+

---

## 🚀 安装方式

Wegent 支持两种主要安装方式：

### 方式 1: Docker Compose（推荐）

适合快速部署和生产环境使用。

### 方式 2: 源码安装

适合开发和自定义部署。

---

## 📦 方式 1: Docker Compose 安装

### 步骤 1: 克隆仓库

```bash
# 克隆 Wegent 仓库
git clone https://github.com/wecode-ai/wegent.git

# 进入项目目录
cd wegent
```

### 步骤 2: 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件
vim .env  # 或使用其他编辑器
```

#### 关键环境变量

```bash
# MySQL 配置
MYSQL_ROOT_PASSWORD=your_root_password
MYSQL_DATABASE=task_manager
MYSQL_USER=task_user
MYSQL_PASSWORD=your_password

# Redis 配置
REDIS_PASSWORD=your_redis_password  # 可选
REDIS_PROTOCOL=2  # 默认使用 RESP2，兼容不支持 HELLO 的 Redis 兼容服务

# 后端配置
PASSWORD_KEY=your-password-key-here
DATABASE_URL=mysql+pymysql://task_user:your_password@mysql:3306/task_manager
CHECK_SYSTEM_INITIALIZATION_STATUS=True

# 附件存储配置（可选）
# 默认: mysql（将文件存储在数据库中）
# 选项: mysql, s3, minio
ATTACHMENT_STORAGE_BACKEND=mysql

# S3/MinIO 配置（仅在使用 s3 或 minio 后端时需要）
# ATTACHMENT_S3_ENDPOINT=https://s3.amazonaws.com  # 或 http://minio:9000
# ATTACHMENT_S3_ACCESS_KEY=your_access_key
# ATTACHMENT_S3_SECRET_KEY=your_secret_key
# ATTACHMENT_S3_BUCKET=attachments
# ATTACHMENT_S3_REGION=us-east-1
# ATTACHMENT_S3_USE_SSL=true

# 前端配置
# 运行时变量（推荐，可在不重新构建的情况下更改）
# 通过 docker-compose.yml 的 environment 部分设置
# RUNTIME_INTERNAL_API_URL=http://backend:8000
# RUNTIME_SOCKET_DIRECT_URL=http://backend:8000
# RUNTIME_WEWORK_CODE_URL=https://wework.example.com/coding  # 可选：编码入口跳转到 Wework
# 旧版（已弃用）: NEXT_PUBLIC_API_URL=http://localhost:8000

# Wework 前端构建配置（可选）
# 用于设置“设置 → 连接”云设备资源说明卡中的扩容 Wiki 链接
# VITE_CLOUD_DEVICE_SCALING_WIKI_URL=https://wiki.example.com/cloud-device-scaling

# 镜像配置
# 使用 CI 发布的 edge 镜像时改为 edge
WEGENT_IMAGE_TAG=latest

# Executor Manager 配置
# 可选：显式覆盖 executor 镜像；未设置时跟随 WEGENT_IMAGE_TAG
# EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:latest
EXECUTOR_WORKSPACE=/path/to/workspace

# 知识库文档转换（PDF/Office/EPUB/HTML/XML/EML 等）
INTERNAL_SERVICE_TOKEN=replace-with-a-shared-secret
KNOWLEDGE_CONVERSION_ENABLED=true
KNOWLEDGE_CONVERSION_QUEUE=knowledge_conversion
# 可选：限制知识库允许上传的文件扩展名；留空时使用系统默认格式注册表
# KNOWLEDGE_UPLOAD_FILE_TYPES=pdf,docx,epub,eml,html,xml,txt,md
# 如仍设置旧的 KNOWLEDGE_CONVERSION_FILE_TYPES，请同步加入新转换格式或清空该配置
# KNOWLEDGE_CONVERSION_FILE_TYPES=pdf,doc,docx,ppt,pptx,xls,xlsx,epub,eml,html,htm,xml
```

`RUNTIME_WEWORK_CODE_URL` 为空时，Wegent Web 的编码入口会进入 `/chat?agent=code`，并只显示编码智能体；配置后，左侧菜单显示 **WeWork** 而不是 **编码**，并打开该运行时 URL。该配置只通过 `/runtime-config` 下发，不支持 `NEXT_PUBLIC_*` 回退。

### 步骤 3: 启动服务

```bash
# 启动所有服务
docker-compose up -d

# 查看服务状态
docker-compose ps

# 查看日志
docker-compose logs -f
```

知识库文档转换、知识检索运行时和 Elasticsearch 使用 `rag` profile。需要上传 PDF、Office、EPUB、HTML、XML、EML 等需要转换或索引的文档时，请使用：

```bash
docker compose --profile rag up -d
```

如果只想启动依赖容器，并在本机运行源码服务，可以先启动：

```bash
docker compose --profile rag up -d mysql redis elasticsearch
```

再分别启动后端、前端、`knowledge_runtime` 和 `knowledge_doc_converter`。

> `knowledge_doc_converter` 必须与后端使用同一个 `INTERNAL_SERVICE_TOKEN`。在 Docker Compose 中由 `BACKEND_INTERNAL_TOKEN` 传给转换服务；在本机源码启动时，请在 `knowledge_doc_converter/.env` 中设置相同的 `BACKEND_INTERNAL_TOKEN`，否则转换服务调用后端内部下载和回调接口会返回 `401 Unauthorized`，文档会停留在“待转换”。

旧版 Office 文件（`.doc`、`.ppt`、`.xls`）需要转换服务环境安装 LibreOffice。Docker 镜像已包含所需组件；本机源码运行时需自行安装：

```bash
# Ubuntu/Debian
sudo apt-get install libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress

# macOS
brew install --cask libreoffice
```

macOS 如需显式指定路径，可在 `knowledge_doc_converter/.env` 中配置：

```bash
SOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice
```

如需测试 CI 发布的 edge 镜像，可以设置统一镜像 tag：

```bash
WEGENT_IMAGE_TAG=edge docker compose up -d
```

使用 `install.sh` 时也可以直接传入 edge 快捷参数：

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash -s -- --edge
```

### 步骤 4: 验证安装

等待服务启动完成（约30秒），数据库表和初始数据会自动创建。

访问以下 URL 验证安装：

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API 文档**: http://localhost:8000/api/docs
- **Executor Manager**: http://localhost:8001

### 步骤 5: 配置 GitHub 集成（可选）

1. 访问 http://localhost:3000
2. 按照界面提示配置 GitHub Personal Access Token
3. Token 权限要求：
   - `repo` - 完整仓库访问
   - `workflow` - 工作流权限

---

## 💻 方式 2: 源码安装

### 步骤 1: 安装依赖软件

#### 在 Ubuntu/Debian 上安装

```bash
# 更新包列表
sudo apt-get update

# 安装 Python
sudo apt-get install python3.10 python3-pip python3-venv

# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 MySQL
sudo apt-get install mysql-server

# 安装 Redis
sudo apt-get install redis-server

# 安装 Git
sudo apt-get install git
```

#### 在 macOS 上安装

```bash
# 使用 Homebrew 安装
brew install python@3.10 node@18 mysql redis git

# 可选：本机运行知识库转换服务并处理 .doc/.ppt/.xls 时需要
brew install --cask libreoffice
```

### 步骤 2: 设置数据库

```bash
# 启动 MySQL
sudo systemctl start mysql  # Linux
# 或
brew services start mysql  # macOS

# 登录 MySQL
mysql -u root -p

# 创建数据库和用户
CREATE DATABASE task_manager;
CREATE USER 'task_user'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON task_manager.* TO 'task_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 步骤 3: 设置 Redis

```bash
# 启动 Redis
sudo systemctl start redis  # Linux
# 或
brew services start redis  # macOS

# 验证 Redis
redis-cli ping  # 应返回 PONG
```

### 步骤 4: 安装后端

```bash
# 进入后端目录
cd backend

# 创建虚拟环境
python3 -m venv venv

# 激活虚拟环境
source venv/bin/activate  # Linux/macOS
# venv\Scripts\activate  # Windows

# 安装依赖
uv sync

# 配置环境变量
cp .env.example .env
vim .env  # 编辑配置

# 创建数据库（表结构和初始数据会在首次启动时自动创建）
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS task_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 运行后端服务
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

> **管理员密码**: 首次启动会自动创建 `admin` 管理员账号，但不会写入默认密码。默认情况下，`CHECK_SYSTEM_INITIALIZATION_STATUS=True` 会让后端启动时把初始化状态加载到内存，第一次打开登录页时系统会强制进入管理员密码设置流程；完成设置后才能登录和继续使用系统。特殊部署需要跳过该检查时，可设置 `CHECK_SYSTEM_INITIALIZATION_STATUS=False`。

### 步骤 5: 安装前端

在新终端中：

```bash
# 回到仓库根目录
cd Wegent

# 安装 pnpm workspace 依赖
pnpm install

# 配置环境变量
cd frontend
cp .env.local.example .env.local
vim .env.local  # 编辑配置

# 运行开发服务器
pnpm run dev
```

仓库根目录的 `pnpm-workspace.yaml` 已声明 pnpm 安装所需的依赖构建脚本 allowlist，并关闭非交互环境下的 `node_modules` 重建确认。开发者和 Git hooks 应从仓库根目录运行 `pnpm install`，不要在子目录中单独维护 `approve-builds` 配置。

### 步骤 6: 安装 Executor Manager

[本地开发](/executor_manager/README_zh.md)

### 步骤 7: 启动知识库转换服务（可选）

当 `KNOWLEDGE_CONVERSION_ENABLED=true` 时，需要运行 `knowledge_doc_converter` worker 才能处理待转换文档：

```bash
cd knowledge_doc_converter
cp .env.example .env
vim .env  # 设置 BACKEND_BASE_URL、BACKEND_INTERNAL_TOKEN 和 Redis 地址

./start.sh
```

`knowledge_doc_converter/.env` 至少应包含：

```bash
BACKEND_BASE_URL=http://localhost:8000
BACKEND_INTERNAL_TOKEN=<same-as-backend-INTERNAL_SERVICE_TOKEN>
CELERY_BROKER_URL=redis://127.0.0.1:6379/0
CELERY_RESULT_BACKEND=redis://127.0.0.1:6379/1
REDIS_URL=redis://127.0.0.1:6379/0
```

如果只运行本机源码服务，避免同时启动 Docker 版 `knowledge_doc_converter`，否则两个 worker 可能消费同一个 `knowledge_conversion` 队列。

---

## ⚙️ 高级配置

### 自定义端口

修改 `docker-compose.yml` 或环境变量来自定义端口：

```yaml
# docker-compose.yml
services:
  frontend:
    ports:
      - "3001:3000" # 改为 3001
  backend:
    ports:
      - "8001:8000" # 改为 8001
```

### 配置 HTTPS

在生产环境中，建议使用 Nginx 反向代理配置 HTTPS：

```bash
# 安装 Nginx
sudo apt-get install nginx

# 配置反向代理
sudo vim /etc/nginx/sites-available/wegent
```

示例 Nginx 配置：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 数据持久化

确保 Docker 卷配置正确以保持数据持久化：

```yaml
# docker-compose.yml
volumes:
  mysql_data:
  redis_data:
  workspace_data:

services:
  mysql:
    volumes:
      - mysql_data:/var/lib/mysql

  redis:
    volumes:
      - redis_data:/data
```

---

## 🔍 验证安装

### 检查服务状态

```bash
# Docker Compose 方式
docker-compose ps

# 应该看到所有服务都是 Up 状态
```

### 测试 API

```bash
# 测试后端 API
curl http://localhost:8000/api/health

# 应返回：{"status": "ok"}
```

### 测试前端

在浏览器中访问 http://localhost:3000，应该看到 Wegent 登录页面。

---

## 🐛 常见问题

### 问题 1: 端口已被占用

**错误**: `Error: Port 3000 is already in use`

**解决方案**:

```bash
# 查找占用端口的进程
lsof -i :3000

# 终止进程
kill -9 <PID>

# 或修改端口配置
```

### 问题 2: MySQL 连接失败

**错误**: `Can't connect to MySQL server`

**解决方案**:

```bash
# 确保 MySQL 正在运行
docker-compose ps mysql
# 或
sudo systemctl status mysql

# 检查连接配置
mysql -u task_user -p -h localhost task_manager
```

### 问题 3: Redis 连接失败

**错误**: `Error connecting to Redis`

**解决方案**:

```bash
# 确保 Redis 正在运行
redis-cli ping

# 检查 Redis 配置
docker-compose logs redis
```

### 问题 4: Docker 镜像拉取失败

**错误**: `Error pulling image`

**解决方案**:

```bash
# 使用国内镜像源
# 编辑 /etc/docker/daemon.json
{
  "registry-mirrors": [
    "https://docker.mirrors.ustc.edu.cn",
    "https://hub-mirror.c.163.com"
  ]
}

# 重启 Docker
sudo systemctl restart docker
```

---

## 🔄 升级和更新

### 升级到最新版本

```bash
# 拉取最新代码
git pull origin main

# 重新构建镜像
docker-compose build

# 重启服务
docker-compose down
docker-compose up -d

# 更新数据库
docker-compose exec backend python -m alembic upgrade head
```

---

## 🗑️ 卸载

### Docker Compose 方式

```bash
# 停止并删除容器
docker-compose down

# 删除卷（会删除所有数据）
docker-compose down -v

# 删除镜像
docker-compose down --rmi all
```

### 源码安装方式

```bash
# 停止所有服务
# 然后删除项目目录
rm -rf wegent

# 删除数据库
mysql -u root -p
DROP DATABASE task_manager;
DROP USER 'task_user'@'localhost';
```

---

## 📞 获取帮助

如果遇到安装问题：

1. 查看 [故障排查指南](../troubleshooting.md)
2. 搜索 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. 查看 [常见问题 FAQ](../faq.md)
4. 创建新的 Issue 报告问题

---

## 🔗 后续步骤

安装完成后，您可以：

- [快速开始](./quick-start.md) - 运行您的第一个任务
- [核心概念](../concepts/core-concepts.md) - 了解 Wegent 的核心概念
- [智能体设置](../user-guide/settings/agent-settings.md) - 配置您的第一个智能体
- [开发指南](../developer-guide/setup.md) - 搭建开发环境

---

<p align="center">安装完成! 开始探索 Wegent 吧! 🎉</p>
