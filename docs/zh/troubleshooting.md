# 🔧 故障排查指南

本指南帮助您诊断和解决 Wegent 平台使用过程中遇到的常见问题。

---

## 📋 目录

- [安装和启动问题](#-安装和启动问题)
- [数据库问题](#-数据库问题)
- [网络和连接问题](#-网络和连接问题)
- [任务执行问题](#-任务执行问题)
- [性能问题](#-性能问题)
- [开发环境问题](#-开发环境问题)

---

## 🚀 安装和启动问题

### 问题 1: Docker Compose 启动失败

**症状**: `docker-compose up -d` 失败或服务无法启动

**可能原因和解决方案**:

**1. Docker 未运行**
```bash
# 检查 Docker 状态
systemctl status docker  # Linux
# 或
open -a Docker  # macOS

# 启动 Docker
sudo systemctl start docker  # Linux
```

**2. 端口被占用**
```bash
# 查找占用端口的进程
lsof -i :3000  # 前端
lsof -i :8000  # 后端
lsof -i :3306  # MySQL
lsof -i :6379  # Redis

# 终止进程
kill -9 <PID>

# 或修改 docker-compose.yml 中的端口映射
```

**3. 权限问题**
```bash
# 添加当前用户到 docker 组
sudo usermod -aG docker $USER

# 重新登录以应用更改
```

**4. 磁盘空间不足**
```bash
# 检查磁盘空间
df -h

# 清理 Docker 资源
docker system prune -a --volumes
```

### 问题 2: 服务启动后立即退出

**诊断步骤**:

```bash
# 查看所有容器状态
docker-compose ps

# 查看特定服务日志
docker-compose logs backend
docker-compose logs frontend
docker-compose logs mysql
docker-compose logs redis

# 查看完整日志
docker-compose logs --tail=100 <service-name>
```

**常见原因**:

**1. 环境变量配置错误**
```bash
# 检查 .env 文件是否存在
ls -la .env

# 验证关键变量
docker-compose config
```

**2. 数据库连接失败**
```bash
# 等待 MySQL 完全启动（可能需要 30-60 秒）
sleep 30

# 测试连接
docker-compose exec mysql mysql -u task_user -p
```

### 问题 3: 数据库初始化失败

**症状**: 数据库表未创建或初始数据未加载

**解决方案**:

```bash
# 1. 确保 MySQL 容器运行正常
docker-compose ps mysql

# 2. 检查后端初始化日志
docker-compose logs backend | grep -i "yaml\|initialization"

# 3. 如果初始化失败，重启后端服务
docker-compose restart backend

# 4. 如果仍然失败，检查 YAML 配置
docker-compose exec backend ls -la /app/init_data/

# 5. 最后手段：重建数据库（警告：会删除所有数据）
docker-compose down -v
docker-compose up -d
```

---

## 💾 数据库问题

### 问题 4: 数据库连接失败

**错误信息**: `Can't connect to MySQL server`, `OperationalError`

**诊断和解决**:

**1. 检查 MySQL 状态**
```bash
# Docker 方式
docker-compose ps mysql
docker-compose logs mysql

# 本地方式
sudo systemctl status mysql
```

**2. 验证连接参数**
```bash
# 检查环境变量
docker-compose exec backend env | grep DATABASE_URL

# 正确格式
DATABASE_URL=mysql+pymysql://task_user:password@mysql:3306/task_manager
```

**3. 测试连接**
```bash
# 从后端容器测试
docker-compose exec backend python -c "
from app.db.session import engine
try:
    conn = engine.connect()
    print('✅ 数据库连接成功')
    conn.close()
except Exception as e:
    print(f'❌ 连接失败: {e}')
"
```

**4. 检查网络**
```bash
# 确保服务在同一网络
docker network ls
docker network inspect wegent-network
```

### 问题 5: 数据库性能慢

**优化方案**:

**1. 添加索引**
```sql
-- 查看慢查询
SHOW FULL PROCESSLIST;

-- 添加常用索引（在 MySQL 中执行）
CREATE INDEX idx_task_status ON tasks(status);
CREATE INDEX idx_task_created_at ON tasks(created_at);
CREATE INDEX idx_bot_name ON bots(name);
```

**2. 优化配置**
```bash
# 在 docker-compose.yml 中添加 MySQL 配置
services:
  mysql:
    command: >
      --innodb_buffer_pool_size=256M
      --max_connections=200
      --query_cache_size=32M
```

**3. 定期清理**
```sql
-- 删除旧日志
DELETE FROM task_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY);

-- 优化表
OPTIMIZE TABLE tasks;
OPTIMIZE TABLE task_logs;
```

---

## 🌐 网络和连接问题

### 问题 6: 前端无法访问

**症状**: 浏览器无法打开 http://localhost:3000

**解决步骤**:

**1. 检查前端服务**
```bash
# 查看状态
docker-compose ps frontend

# 查看日志
docker-compose logs frontend

# 重启服务
docker-compose restart frontend
```

**2. 检查端口占用**
```bash
# 查找占用 3000 端口的进程
lsof -i :3000
netstat -tlnp | grep 3000  # Linux

# 修改端口（如果需要）
# 编辑 docker-compose.yml
ports:
  - "3001:3000"  # 使用 3001 代替
```

**3. 检查防火墙**
```bash
# Ubuntu/Debian
sudo ufw status
sudo ufw allow 3000

# CentOS/RHEL
sudo firewall-cmd --list-ports
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

### 问题 7: API 请求失败 (CORS 错误)

**症状**: 浏览器控制台显示 CORS 错误

**解决方案**:

**1. 检查后端 CORS 配置**
```python
# backend/app/main.py
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**2. 检查前端 API URL**
```bash
# frontend/.env.local 或环境变量
# 运行时变量（推荐，可在不重新构建的情况下更改）：
RUNTIME_INTERNAL_API_URL=http://localhost:8000
RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000

# 旧版（已弃用）：
# NEXT_PUBLIC_API_URL=http://localhost:8000
```

> **注意**: 前端现在使用 `RUNTIME_INTERNAL_API_URL` 替代 `NEXT_PUBLIC_API_URL`。运行时变量可以在不重新构建应用的情况下更改。

**3. 使用浏览器开发工具调试**
- 打开 F12 开发者工具
- 查看 Network 标签
- 检查请求和响应头

### 问题 8: WebSocket 连接失败

**症状**: 聊天功能不工作、无法接收实时更新、控制台显示 Socket.IO 连接错误

**解决方案**:

**1. 检查 Socket.IO 服务器状态**
```bash
# 查看后端日志中的 Socket.IO 初始化信息
docker-compose logs backend | grep -i "socket"

# 验证 Socket.IO 端点是否可访问
curl -I http://localhost:8000/socket.io/
```

**2. 验证 JWT Token**
```bash
# 在浏览器控制台检查 token 是否有效
localStorage.getItem('token')

# Token 应该在 Socket.IO auth 中传递
```

**3. 检查 WebSocket 的 CORS 配置**
```python
# backend/app/core/socketio.py
# 确保 CORS 源配置正确
SOCKETIO_CORS_ORIGINS = "*"  # 或特定的源
```

**4. 验证 Redis 连接（多工作进程必需）**
```bash
# Socket.IO 适配器需要 Redis
docker-compose exec redis redis-cli ping
```

**5. 检查前端 Socket.IO 配置**
```typescript
// frontend/src/contexts/SocketContext.tsx
// 验证连接参数
const socket = io(API_URL + '/chat', {
  path: '/socket.io',
  auth: { token },
  transports: ['websocket', 'polling'],
});
```

**6. 在浏览器中调试 WebSocket**
- 打开 F12 开发者工具
- 进入 Network 标签 → WS 过滤器
- 检查 WebSocket 连接状态和消息

### 问题 9: GitHub API 连接失败

**症状**: 无法克隆仓库或访问 GitHub

**解决方案**:

**1. 检查 Token 配置**
```bash
# 验证 Token 权限
curl -H "Authorization: token YOUR_TOKEN" \
     https://api.github.com/user
```

**2. 检查网络连接**
```bash
# 测试 GitHub 连接
ping github.com
curl -I https://github.com
```

**3. 配置代理（如果需要）**
```bash
# 在 .env 中添加
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080

# 或在 Git 配置中
git config --global http.proxy http://proxy.example.com:8080
```

**4. 使用 SSH 而非 HTTPS**
```bash
# 配置 SSH key
ssh-keygen -t ed25519 -C "your_email@example.com"
cat ~/.ssh/id_ed25519.pub  # 添加到 GitHub

# 测试连接
ssh -T git@github.com
```

---

## ⚙️ 任务执行问题

### 问题 10: 任务一直处于 PENDING 状态

**诊断流程**:

**1. 检查 Executor Manager**
```bash
# 查看状态
docker-compose ps executor_manager

# 查看日志
docker-compose logs executor_manager

# 重启服务
docker-compose restart executor_manager
```

**2. 检查可用的 Executors**
```bash
# 列出所有 Executor 容器
docker ps | grep executor

# 查看具体 Executor 日志
docker logs <executor-container-id>
```

**3. 检查资源限制**
```bash
# 查看并发限制
docker-compose exec executor_manager env | grep MAX_CONCURRENT_TASKS

# 增加限制（在 .env 中）
MAX_CONCURRENT_TASKS=10
```

**4. 检查任务配置**
```bash
# 使用 API 查看任务详情
curl http://localhost:8000/api/tasks/<task-id>

# 检查 Bot、Shell、Model 配置是否正确
```

### 问题 11: 任务执行失败

**诊断步骤**:

**1. 查看任务错误信息**
```bash
# API 方式
curl http://localhost:8000/api/tasks/<task-id>

# 查看数据库
docker-compose exec mysql mysql -u task_user -p task_manager \
  -e "SELECT id, status, error_message FROM tasks WHERE id='<task-id>';"
```

**2. 查看 Executor 日志**
```bash
# 找到执行该任务的 Executor
docker ps | grep executor

# 查看详细日志
docker logs -f <executor-container-id>
```

**3. 常见失败原因**:

| 错误类型 | 可能原因 | 解决方案 |
|---------|---------|---------|
| `Bot not found` | Bot 配置不存在 | 检查 Bot 名称和配置 |
| `Model configuration error` | 模型配置错误 | 验证 API Key 和模型名称 |
| `Shell not available` | Shell 不支持 | 确认 Shell 类型正确 |
| `Timeout` | 执行超时 | 增加超时设置或优化任务 |
| `Out of memory` | 内存不足 | 增加容器内存限制 |

### 问题 12: Agent 无响应或卡住

**解决方案**:

**1. 设置超时**
```bash
# 在环境变量中设置
TASK_TIMEOUT=600  # 10 分钟
```

**2. 检查 Agent 配置**
```yaml
# 确保模型配置正确
spec:
  modelConfig:
    env:
      ANTHROPIC_API_KEY: "sk-xxx"  # 验证 Key 有效
      ANTHROPIC_MODEL: "claude-sonnet-4"  # 验证模型名称
```

**3. 重启 Executor**
```bash
# 杀死卡住的 Executor
docker kill <executor-container-id>

# Executor Manager 会自动创建新的
```

---

## ⚡ 性能问题

### 问题 13: 系统响应慢

**诊断和优化**:

**1. 检查资源使用**
```bash
# CPU 和内存使用
docker stats

# 磁盘 I/O
iostat -x 1

# 网络
netstat -s
```

**2. 优化数据库**
```sql
-- 查看慢查询
SHOW FULL PROCESSLIST;

-- 启用慢查询日志
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 2;

-- 查看慢查询
SELECT * FROM mysql.slow_log;
```

**3. 优化 Redis**
```bash
# 检查 Redis 性能
docker-compose exec redis redis-cli INFO stats

# 清理过期 key
docker-compose exec redis redis-cli FLUSHDB  # 谨慎使用
```

**4. 增加资源限制**
```yaml
# docker-compose.yml
services:
  backend:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
```

### 问题 14: 磁盘空间不足

**清理方案**:

```bash
# 1. 清理 Docker 资源
docker system prune -a --volumes

# 2. 清理日志文件
truncate -s 0 /var/lib/docker/containers/**/*-json.log

# 3. 清理旧数据
# 登录 MySQL
docker-compose exec mysql mysql -u task_user -p task_manager

# 删除旧任务记录
DELETE FROM tasks WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
DELETE FROM task_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY);

# 4. 清理 workspace
find /path/to/workspace -type d -mtime +90 -exec rm -rf {} \;
```

---

## 💻 开发环境问题

### 问题 15: Python 依赖安装失败

**解决方案**:

```bash
# 1. 升级 pip
pip install --upgrade pip setuptools wheel

# 2. 使用镜像源
uv pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r pyproject.toml

# 3. 分别安装依赖
uv pip install --no-deps -r pyproject.toml
uv pip install <specific-package>

# 4. 使用 conda（如果 pip 失败）
conda create -n wegent python=3.10
conda activate wegent
uv sync
```

### 问题 16: Node.js 依赖安装失败

**解决方案**:

```bash
# 1. 清理缓存
npm cache clean --force
rm -rf node_modules package-lock.json

# 2. 使用淘宝镜像
npm config set registry https://registry.npmmirror.com
npm install

# 3. 使用 yarn
npm install -g yarn
yarn install

# 4. 降低 Node.js 版本（如果兼容性问题）
nvm install 18
nvm use 18
npm install
```

### 问题 17: 热重载不工作

**前端热重载**:
```bash
# 检查文件监视限制
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# 重启开发服务器
npm run dev
```

**后端热重载**:
```bash
# 确保使用 --reload 参数
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 检查文件权限
ls -la backend/app/
```

---

## 🔍 调试技巧

### 启用详细日志

**后端**:
```bash
# 在 .env 中设置
LOG_LEVEL=DEBUG

# 重启服务
docker-compose restart backend
```

**前端**:
```bash
# 在浏览器控制台查看
localStorage.setItem('debug', '*')

# 刷新页面
```

**Executor**:
```bash
# 进入容器查看详细日志
docker exec -it <executor-id> /bin/bash
tail -f /var/log/executor.log
```

### 使用开发工具

**1. 浏览器开发工具**:
- Network: 查看 API 请求
- Console: 查看错误和日志
- Application: 查看本地存储

**2. Python 调试**:
```python
# 使用 pdb
import pdb; pdb.set_trace()

# 使用 logging
import logging
logging.basicConfig(level=logging.DEBUG)
```

**3. Docker 调试**:
```bash
# 进入容器
docker exec -it <container-id> /bin/bash

# 查看环境变量
env

# 查看进程
ps aux

# 查看端口
netstat -tlnp
```

---

## 📞 获取帮助

如果以上方法无法解决您的问题：

1. 📖 查看 [FAQ](./faq.md)
2. 🔍 搜索 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. 💬 创建新的 Issue，提供：
   - 详细的错误信息
   - 复现步骤
   - 环境信息（OS、Docker版本等）
   - 相关日志
4. 🌟 加入社区讨论

---

## 📝 报告问题的最佳实践

创建 Issue 时请包含：

```markdown
## 环境信息
- OS: Ubuntu 22.04
- Docker: 24.0.6
- Wegent版本: v1.0.13

## 问题描述
简要描述问题...

## 复现步骤
1. 执行 xxx
2. 点击 xxx
3. 出现错误 xxx

## 期望行为
应该显示 xxx...

## 实际行为
实际显示 xxx...

## 日志
```
粘贴相关日志...
```

## 截图
如果适用，添加截图...
```

---

<p align="center">希望本指南能帮助您解决问题! 🎉</p>
