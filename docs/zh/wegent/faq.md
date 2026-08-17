# ❓ 常见问题 (FAQ)

本文档收集了 Wegent 平台使用过程中的常见问题和解答。

---

## 📋 目录

- [安装和部署](#-安装和部署)
- [配置和使用](#-配置和使用)
- [开发相关](#-开发相关)
- [智能体和团队](#-智能体和团队)
- [性能和优化](#-性能和优化)
- [故障排查](#-故障排查)

---

## 🔧 安装和部署

### Q1: Wegent 支持哪些操作系统？

**A:** Wegent 支持所有主流操作系统：

- **Linux**: Ubuntu 20.04+, Debian 11+, CentOS 8+
- **macOS**: macOS 11+
- **Windows**: Windows 10/11 (通过 WSL2 或 Docker Desktop)

推荐使用 Linux 或 macOS 进行生产部署。

### Q2: 最低硬件配置是什么？

**A:** 最低配置：
- **CPU**: 2 核
- **内存**: 4 GB
- **存储**: 20 GB

推荐配置（用于生产环境）：
- **CPU**: 4 核或更多
- **内存**: 8 GB 或更多
- **存储**: 50 GB 或更多（SSD 优先）

### Q3: 可以在云平台上部署吗？

**A:** 可以。Wegent 支持在各种云平台上部署：

- **AWS**: EC2, ECS, EKS
- **Google Cloud**: Compute Engine, GKE
- **Azure**: Virtual Machines, AKS
- **阿里云**: ECS, ACK
- **腾讯云**: CVM, TKE

使用 Docker Compose 可以在任何支持 Docker 的环境中部署。

### Q4: 是否需要域名和 SSL 证书？

**A:**
- **开发环境**: 不需要，使用 `localhost` 即可
- **生产环境**: 强烈推荐配置域名和 SSL 证书
  - 可以使用 Let's Encrypt 获取免费 SSL 证书
  - 使用 Nginx 或 Traefik 作为反向代理

### Q5: 支持 Docker 以外的部署方式吗？

**A:** 支持。除了 Docker Compose，还可以：

- **源码部署**: 直接运行 Python 和 Node.js 服务
- **二进制部署**: 构建后端为可执行文件（需要额外配置）

---

## ⚙️ 配置和使用

### Q6: 如何配置多个 AI 模型？

**A:** 在 Model 资源中配置不同的环境变量：

```yaml
# Claude 模型
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: claude-sonnet
spec:
  modelConfig:
    env:
      ANTHROPIC_MODEL: "claude-sonnet-4"
      ANTHROPIC_API_KEY: "sk-xxx"

---
# GPT 模型
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: gpt-4
spec:
  modelConfig:
    env:
      OPENAI_API_KEY: "sk-xxx"
      OPENAI_MODEL: "gpt-4"
```

### Q7: GitHub Token 需要哪些权限？

**A:** GitHub Personal Access Token 需要以下权限：

- ✅ `repo` - 完整的仓库访问权限
- ✅ `workflow` - 工作流权限
- ✅ `read:org` - 读取组织信息（如果使用组织仓库）

创建 Token 的步骤：
1. GitHub Settings → Developer settings → Personal access tokens
2. 选择 "Tokens (classic)"
3. Generate new token
4. 选择上述权限
5. 复制 Token 到 Wegent 配置

### Q8: 如何配置代理服务器？

**A:** 在环境变量中配置代理：

```bash
# HTTP/HTTPS 代理
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080

# 或在 .env 文件中
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=localhost,127.0.0.1
```

### Q9: 支持多用户吗？

**A:** 当前版本支持基础的多用户功能：

- 每个用户有独立的工作空间
- 可以配置不同的 GitHub Token
- Team 和 Bot 可以在用户间共享（根据命名空间）

未来版本将支持更完善的权限管理和用户隔离。

### Q10: 如何备份数据？

**A:** 主要需要备份以下内容：

**1. MySQL 数据库：**
```bash
# 备份
docker-compose exec mysql mysqldump -u task_user -p task_manager > backup.sql

# 恢复
docker-compose exec -T mysql mysql -u task_user -p task_manager < backup.sql
```

**2. 工作空间文件：**
```bash
# 备份 workspace 目录
tar -czf workspace_backup.tar.gz /path/to/workspace

# 恢复
tar -xzf workspace_backup.tar.gz -C /path/to/restore
```

**3. 配置文件：**
- `.env` 文件
- `docker-compose.yml`
- 自定义的 YAML 配置

---

## 💻 开发相关

### Q11: 如何调试智能体执行过程？

**A:** 几种调试方法：

**1. 查看 Executor 日志：**
```bash
# Docker 方式
docker-compose logs -f executor

# 查看特定 Executor
docker logs -f <executor-container-id>
```

**2. 启用详细日志：**
```bash
# 在 .env 中设置
LOG_LEVEL=DEBUG
```

**3. 进入 Executor 容器：**
```bash
docker exec -it <executor-container-id> /bin/bash
```

### Q12: 如何开发自定义 Agent？

**A:** 开发自定义 Agent 的步骤：

1. 在 `executor/agents/` 目录下创建新 Agent
2. 继承 `BaseAgent` 类
3. 实现必要的方法：
   - `initialize()`
   - `execute()`
   - `cleanup()`
4. 在 `agent_factory.py` 中注册 Agent
5. 创建对应的 Shell 配置

### Q13: 支持哪些编程语言开发？

**A:**

**核心平台：**
- 后端：Python 3.10+ (FastAPI)
- 前端：TypeScript (Next.js 15)
- Executor：Python 3.10+

**智能体可以使用：**
- Python（推荐）
- JavaScript/TypeScript
- 其他语言（需要自定义 Agent 实现）

### Q14: 如何贡献代码？

**A:** 参考项目根目录的 CONTRIBUTING.md 文件：

1. Fork 仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 编写代码和测试
4. 提交 Pull Request
5. 等待代码审查

### Q15: 前端和后端能分开部署吗？

**A:** 可以。修改前端环境变量指向后端 API：

```bash
# frontend/.env.local
NEXT_PUBLIC_API_URL=https://api.your-domain.com
```

确保后端配置了正确的 CORS 设置。

---

## 🤖 智能体和团队

### Q16: Ghost、Bot、Team 有什么区别？

**A:**

- **Ghost**: 智能体的"灵魂"，定义个性和能力
- **Bot**: 完整的智能体实例 = Ghost + Shell + Model
- **Team**: 多个 Bot 的协作组合，定义工作流

关系：`Ghost + Shell + Model → Bot → Team`

详见 [核心概念](./concepts/core-concepts.md)

### Q17: 一个 Team 最多可以有多少个 Bot？

**A:** 理论上没有限制，但建议：

- **对话模式**: 3-5 个 Bot
- **编码模式**: 1-3 个 Bot
- **复杂工作流**: 5-10 个 Bot

太多 Bot 可能导致：
- 上下文混乱
- 性能下降
- 成本增加

### Q18: 四种协作模式如何选择？

**A:** 根据任务类型选择：

| 协作模式 | 适用场景 | 示例 |
|---------|---------|------|
| **Pipeline** | 顺序执行任务 | 开发→审查→测试→部署 |
| **Route** | 根据内容分配 | 路由到专家 Bot |
| **Coordinate** | 并行任务汇总 | 多角度分析 |
| **Collaborate** | 自由讨论 | 头脑风暴、问题解决 |

详见 [协作模式详解](./concepts/collaboration-models.md)

### Q19: Bot 可以复用吗？

**A:** 可以。Bot 可以在多个 Team 中复用：

```yaml
# Team 1
spec:
  members:
    - botRef:
        name: shared-developer-bot  # 复用

# Team 2
spec:
  members:
    - botRef:
        name: shared-developer-bot  # 复用
```

但每个 Team 可以为同一个 Bot 配置不同的任务提示词。

### Q20: 如何控制智能体的成本？

**A:** 几种方法：

1. **选择合适的模型**：
   - 简单任务用 Haiku（便宜）
   - 复杂任务用 Sonnet 或 Opus

2. **优化提示词**：
   - 清晰明确的指令
   - 避免冗余内容

3. **设置限制**：
   - 最大 Token 数
   - 超时时间
   - 最大重试次数

4. **监控使用情况**：
   - 查看任务日志
   - 统计 API 调用次数

---

## ⚡ 性能和优化

### Q21: 如何提高任务执行速度？

**A:** 几种优化方法：

1. **增加并发执行器**：
```bash
# 在 .env 中设置
MAX_CONCURRENT_TASKS=10  # 默认是 5
```

2. **使用更快的模型**：
   - Haiku 比 Sonnet 快
   - 本地模型比 API 快

3. **优化 Docker 配置**：
   - 使用 SSD
   - 增加内存限制
   - 使用镜像缓存

4. **优化数据库**：
   - 定期清理日志
   - 添加索引
   - 使用连接池

### Q22: 系统支持多少并发任务？

**A:** 取决于硬件配置：

| 硬件配置 | 推荐并发数 |
|---------|----------|
| 2核4GB | 2-3 |
| 4核8GB | 5-8 |
| 8核16GB | 10-15 |
| 16核32GB | 20-30 |

通过 `MAX_CONCURRENT_TASKS` 环境变量调整。

### Q23: Redis 是必需的吗？

**A:**

- **开发环境**: 可选，用于会话管理和缓存
- **生产环境**: 强烈推荐，提供：
  - 任务队列
  - 会话缓存
  - 速率限制
  - 实时通知

不使用 Redis 会影响性能和功能。

---

## 🔍 故障排查

### Q24: 任务一直处于 PENDING 状态怎么办？

**A:** 可能的原因和解决方案：

1. **Executor Manager 未运行**：
```bash
docker-compose ps executor_manager
docker-compose logs executor_manager
```

2. **没有可用的 Executor**：
```bash
docker ps | grep executor
```

3. **资源不足**：
   - 检查 CPU 和内存使用
   - 增加 `MAX_CONCURRENT_TASKS`

4. **配置错误**：
   - 检查 Bot、Shell、Model 配置
   - 查看错误日志

详见 [故障排查指南](./troubleshooting.md)

### Q25: API 返回 500 错误怎么办？

**A:**

1. **查看后端日志**：
```bash
docker-compose logs backend
```

2. **检查数据库连接**：
```bash
docker-compose exec backend python -c "from app.db import engine; engine.connect()"
```

3. **检查环境变量**：
```bash
docker-compose exec backend env | grep DATABASE_URL
```

### Q26: 前端无法连接后端？

**A:**

1. **检查 API URL 配置**：
```bash
# frontend/.env.local 或环境变量
# 运行时变量（推荐，可在不重新构建的情况下更改）：
RUNTIME_INTERNAL_API_URL=http://localhost:8000
RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000

# 旧版（已弃用）：
# NEXT_PUBLIC_API_URL=http://localhost:8000
```

> **注意**: 前端现在使用 `RUNTIME_INTERNAL_API_URL` 替代 `NEXT_PUBLIC_API_URL`。运行时变量可以在不重新构建应用的情况下更改。

2. **检查 CORS 设置**：
   - 确保后端允许前端域名

3. **检查防火墙**：
   - 确保端口 8000 未被阻止

4. **检查服务状态**：
```bash
curl http://localhost:8000/api/health
```

---

## 📞 获取更多帮助

如果您的问题未在此列出：

1. 📖 查看 [完整文档](./README.md)
2. 🔍 搜索 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. 🐛 查看 [故障排查指南](./troubleshooting.md)
4. 💬 创建新的 Issue 描述问题
5. 🌟 加入社区讨论

---

## 🔄 持续更新

本 FAQ 会根据用户反馈持续更新。如果您有新的问题或建议，欢迎：

- 提交 Issue
- 提交 Pull Request
- 参与社区讨论

---

<p align="center">希望这些解答对您有帮助! 🎉</p>
