# 📚 Wegent 中文文档

欢迎来到 Wegent 中文文档中心！

Wegent 是一个开源的 AI 原生操作系统，使您能够大规模定义、组织和运行智能代理。

---

## 📖 目录导航

### 🚀 快速开始

开始使用 Wegent 的第一步指南：

- [快速开始](./getting-started/quick-start.md) - 5 分钟快速上手 Wegent
- [详细安装](./getting-started/installation.md) - 完整的安装配置指南

### 🧠 核心概念

深入理解 Wegent 的核心设计：

- [架构概览](./concepts/architecture.md) - Wegent 整体架构和技术栈
- [核心概念](./concepts/core-concepts.md) - Ghost、Bot、Team、Workspace 等核心概念详解
- [协作模式](./concepts/collaboration-models.md) - Pipeline、Route、Coordinate、Collaborate 四种协作模式

### 📖 使用指南

#### 👤 用户指南

面向 Wegent 平台用户的操作指南:

- [创建 Ghost](./guides/user/creating-ghosts.md) - 定义智能体的"灵魂"
- [创建 Bot](./guides/user/creating-bots.md) - 组装完整的智能体实例
- [管理 Skills](./guides/user/managing-skills.md) - 上传和使用 Claude Code Skills
- [创建 Team](./guides/user/creating-teams.md) - 构建协作团队
- [管理任务](./guides/user/managing-tasks.md) - 创建和管理工作任务
- [需求规范澄清](./guides/user/spec-clarification-guide.md) - Spec Clarification 需求澄清使用指南

#### 💻 开发者指南

面向 Wegent 开发者的技术文档：

- [开发环境搭建](./guides/developer/setup.md) - 本地开发环境配置
- [测试](./guides/developer/testing.md) - 单元测试和集成测试
- [数据库迁移](./guides/developer/database-migrations.md) - Alembic 数据库迁移管理

### 📋 参考文档

详细的技术参考资料：

- [YAML 规范](./reference/yaml-specification.md) - 完整的 YAML 配置格式说明
- [OpenAPI Responses API](./reference/openapi-responses.md) - Responses API 接口参考

### 📝 配置示例

- [Team 配置示例](../examples/team-example.yaml) - 完整的 Team YAML 配置示例

### 🤝 贡献指南

- [贡献指南](../../../CONTRIBUTING.md) - 如何参与 Wegent 项目贡献

### 🔧 帮助与支持

- [常见问题 FAQ](./faq.md) - 常见问题解答
- [故障排查](./troubleshooting.md) - 问题诊断和解决方案

---

## 🌟 核心特性一览

### 🎨 配置驱动的智能体团队
通过 YAML 配置定义和运行个性化 Agent 团队，提供网页 UI，无需二次开发。

### ⚙️ 多引擎架构
底层支持 Agno 和 Claude Code 两个 Agent 执行引擎，上层支持对话和编码两种模式。

### 🔒 独立沙箱环境
每个 Agent 团队运行在独立沙箱环境中，支持多个 Agent 团队同时运行。

### 🤝 高级协作模式
对话模式可以实现并行、Leader 等 Agent 协作模式，完成新闻洞察、内容检索等复杂工作流。

### 💻 AI 编码集成
编码模式可以与 GitHub/GitLab 等代码服务对接，实现代码开发、review 等 AI Coding 工作流。

---

## 🔗 相关链接

- [English Documentation](../en/README.md) - 英文文档
- [GitHub Repository](https://github.com/wecode-ai/wegent) - 源代码仓库
- [GitHub Issues](https://github.com/wecode-ai/wegent/issues) - 问题反馈

---

## 💡 文档约定

本文档中使用的图标说明：

- 📘 基础内容
- 🔧 实践操作
- ⚠️ 重要提示
- 💡 最佳实践
- 📝 示例代码
- 🚀 高级主题

---

<p align="center">由 WeCode-AI 团队用 ❤️ 制作</p>
