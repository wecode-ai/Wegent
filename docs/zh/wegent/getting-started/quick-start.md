---
sidebar_position: 1
---

# 🚀 快速开始

本指南将帮助您快速上手 Wegent 平台。

---

## 📋 前置要求

在开始之前，请确保您的系统已安装：

- **Docker** 和 **Docker Compose**

---

## ⚡ 一键启动

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```

然后在浏览器中访问 http://localhost:3000

> 可选：启用 RAG 功能 `docker compose --profile rag up -d`

---

## 📦 预置智能体

| 团队 | 用途 |
|------|------|
| chat-team | 通用 AI 助手 + Mermaid 图表 |
| translator | 多语言翻译 |
| dev-team | Git 工作流：分支 → 编码 → 提交 → PR |
| wiki-team | 代码库 Wiki 文档生成 |

---

## 🏗️ 架构

```
Frontend (Next.js) → Backend (FastAPI) → Executor Manager → Executors (ClaudeCode/Dify/Chat)
```

**核心概念：**
- **Ghost** (提示词) + **Shell** (执行环境) + **Model** = **Bot**
- 多个 **Bot** + **协作模式** = **Team**

---

## 📖 下一步

现在您已经成功启动了 Wegent！接下来可以：

### 📚 深入学习

- [详细安装指南](./installation.md) - 了解生产环境部署
- [核心概念](../concepts/core-concepts.md) - 理解 Ghost、Bot、Team 等核心概念
- [架构概览](../developer-guide/architecture.md) - 了解 Wegent 的整体架构

### 🎨 创建自定义智能体

- [智能体设置](../user-guide/settings/agent-settings.md) - 配置智能体和机器人
- [协作模式](../concepts/collaboration-models.md) - 了解多机器人协作方式

### 💻 开发与扩展

- [开发环境搭建](../developer-guide/setup.md) - 搭建本地开发环境

---

## 🔧 常见问题

### 服务启动失败？

```bash
# 查看服务日志
docker compose logs -f

# 重启服务
docker compose restart
```

### 无法访问 Web 界面？

- 确保端口 3000 未被占用
- 检查 Docker 容器是否正常运行：`docker compose ps`

### API 连接失败？

- 确保后端服务正常运行
- 访问 http://localhost:8000/api/docs 检查 API 状态

---

## 📞 获取帮助

- 📖 [完整文档](../README.md)
- 🐛 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
- 💬 [Discord 社区](https://discord.gg/MVzJzyqEUp)

---

<p align="center">祝您使用愉快！🎉</p>
