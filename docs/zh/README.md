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

- [架构概览](./developer-guide/architecture.md) - Wegent 整体架构和技术栈
- [核心概念](./concepts/core-concepts.md) - Ghost、Bot、Team、Workspace 等核心概念详解
- [协作模式](./concepts/collaboration-models.md) - Pipeline、Route、Coordinate、Collaborate 四种协作模式

### 📖 使用指南

#### 👤 用户指南

面向 Wegent 平台用户的操作指南:

- [智能体设置](./user-guide/settings/agent-settings.md) - 配置智能体、机器人、提示词和协作模式
- [管理任务](./user-guide/chat/managing-tasks.md) - 创建和管理工作任务
- [配置模型](./user-guide/settings/configuring-models.md) - 设置 AI 模型（LLM、Embedding、Rerank）
- [配置执行器](./user-guide/settings/configuring-shells.md) - 配置执行环境
- [管理 Skills](./user-guide/settings/managing-skills.md) - 上传和使用 Claude Code Skills
- [需求规范澄清](./user-guide/coding/spec-clarification-guide.md) - Spec Clarification 需求澄清使用指南
- [知识库使用指南](./user-guide/knowledge/knowledge-base-guide.md) - RAG 知识库系统使用指南
- [IM 通道集成](./user-guide/integrations/im-channel-integration.md) - 集成钉钉等 IM 通道
- [本地设备支持](./user-guide/ai-devices/local-device-support.md) - 使用个人电脑作为任务执行器

#### 💻 开发者指南

面向 Wegent 开发者的技术文档：

- [开发环境搭建](./developer-guide/setup.md) - 本地开发环境配置
- [测试](./developer-guide/testing.md) - 单元测试和集成测试
- [数据库迁移](./developer-guide/database-migrations.md) - Alembic 数据库迁移管理

### 📋 参考文档

详细的技术参考资料：

- [YAML 规范](./reference/yaml-specification.md) - 完整的 YAML 配置格式说明

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
底层支持 Chat、Claude Code 和 Dify 等执行路径，上层支持对话、编码和工作流模式。

### 🔒 独立沙箱环境
每个 Agent 团队运行在独立沙箱环境中，支持多个 Agent 团队同时运行。

### 🤝 高级协作模式
智能体团队支持 Solo、Pipeline 和 Coordinate 等协作模式，完成内容检索、代码审查等复杂工作流。

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
