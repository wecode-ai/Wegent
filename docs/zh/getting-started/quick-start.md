# 🚀 快速开始

本指南将帮助您在 5 分钟内快速上手 Wegent 平台。

---

## 📋 前置要求

在开始之前,请确保您的系统已安装:

- **Docker** 和 **Docker Compose**
- **Git**

---

## ⚡ 5 步快速启动

### 步骤 1: 克隆仓库

```bash
git clone https://github.com/wecode-ai/wegent.git
cd wegent
```

### 步骤 2: 启动平台

```bash
docker-compose up -d
```

这将启动所有必需的服务:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API 文档**: http://localhost:8000/api/docs
- **MySQL**: localhost:3306
- **Redis**: localhost:6379
- **Executor Manager**: http://localhost:8001

### 步骤 3: 访问 Web 界面

在浏览器中打开 http://localhost:3000

### 步骤 4: 配置 GitHub 访问令牌

按照页面说明配置您的 GitHub 访问令牌,以便与代码仓库集成。

**创建 GitHub Token 的步骤:**

1. 访问 GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. 点击 "Generate new token (classic)"
3. 设置权限范围:
   - `repo` - 完整仓库访问权限
   - `workflow` - 工作流权限
4. 生成并复制 Token
5. 在 Wegent 平台中配置此 Token

### 步骤 5: 配置 Bot

Wegent 内置了一个开发 Bot。对于 Claude Code 运行时,请设置以下环境变量:

```json
{
  "env": {
    "ANTHROPIC_MODEL": "openrouter,anthropic/claude-sonnet-4",
    "ANTHROPIC_AUTH_TOKEN": "sk-xxxxxx",
    "ANTHROPIC_BASE_URL": "http://xxxxx",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "openrouter,anthropic/claude-haiku-4.5"
  }
}
```

⚠️ **注意**: 部分运行时可能使用 `ANTHROPIC_API_KEY` 而非 `ANTHROPIC_AUTH_TOKEN`,具体以文档说明为准。

📖 **需要更详细的配置说明?**
- [Shell (执行器) 配置完整指南](../guides/user/configuring-shells.md)
- [Model (模型) 配置完整指南](../guides/user/configuring-models.md)

---

## 🎯 运行您的第一个任务

1. **选择项目和分支**
   - 在任务页面选择您的 GitHub 项目
   - 选择目标分支

2. **描述开发需求**

   例如:
   ```
   使用 Python 实现冒泡排序算法,包含完整的文档字符串和单元测试
   ```

3. **提交任务**

   点击提交后,智能体团队将自动:
   - 创建新分支
   - 编写代码
   - 提交更改
   - 创建 Pull Request

4. **查看结果**

   在任务详情页查看执行进度和结果

---

## 📖 下一步

现在您已经成功运行了第一个任务! 接下来可以:

### 📚 深入学习

- [详细安装指南](./installation.md) - 了解生产环境部署
- [核心概念](../concepts/core-concepts.md) - 理解 Ghost、Bot、Team 等核心概念
- [架构概览](../concepts/architecture.md) - 了解 Wegent 的整体架构

### 🎨 创建自定义智能体

- [创建 Ghost](../guides/user/creating-ghosts.md) - 定义智能体的"灵魂"
- [创建 Bot](../guides/user/creating-bots.md) - 组装完整的智能体实例
- [创建 Team](../guides/user/creating-teams.md) - 构建协作团队

### 💻 开发和扩展

- [开发环境搭建](../guides/developer/setup.md) - 搭建本地开发环境

---

## 🔧 常见问题

### 服务启动失败?

```bash
# 查看服务日志
docker-compose logs -f

# 重启服务
docker-compose restart
```

### 无法访问 Web 界面?

- 确保端口 3000 未被占用
- 检查 Docker 容器是否正常运行: `docker-compose ps`

### API 连接失败?

- 确保后端服务正常运行
- 访问 http://localhost:8000/api/docs 检查 API 状态

---

## 📞 获取帮助

- 📖 [完整文档](../README.md)
- 🐛 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
- 💬 [常见问题 FAQ](../faq.md)

---

<p align="center">祝您使用愉快! 🎉</p>
