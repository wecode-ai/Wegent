---
sidebar_position: 6
---

# ⚙️ 设置

设置模块提供 Wegent 系统的各项配置功能，包括智能体、模型、执行器和技能的配置管理。

---

## 📋 本模块文档

| 文档 | 说明 |
|------|------|
| [智能体设置](./agent-settings.md) | 配置智能体（Agent）、机器人（Bot）、提示词和协作模式 |
| [配置模型](./configuring-models.md) | 配置 AI 模型（Anthropic Claude、OpenAI GPT 等） |
| [配置执行器](./configuring-shells.md) | 配置运行时环境（ClaudeCode、Agno、Dify） |
| [管理 Skills](./managing-skills.md) | 上传、管理和使用 Skills 能力扩展包 |

---

## 🎯 核心配置

### 智能体设置

配置 AI 智能体的核心组件：

```
智能体 (Agent/Team) = 机器人(Bot) + 协作模式
机器人 (Bot) = 执行器 (Shell) + 模型 (Model) + 提示词 (Prompt) + MCP 工具 + Skills
```

**协作模式**：
- **Solo**：单个机器人独立工作
- **Pipeline**：顺序执行，形成处理流水线
- **Route**：领导者根据内容路由到合适的专家
- **Coordinate**：领导者协调并行执行，汇总结果
- **Collaborate**：所有成员自由讨论，共享上下文

### 模型配置

支持多种 AI 模型提供商：

| 提供商 | 支持的模型 |
|--------|-----------|
| **Anthropic** | Claude Haiku 4、Claude Sonnet 4、Claude Opus |
| **OpenAI** | GPT-4、GPT-4 Turbo、GPT-3.5 Turbo |

### 执行器配置

支持多种运行时环境：

| 执行器 | 说明 | 适用场景 |
|--------|------|----------|
| **ClaudeCode** | Claude Code SDK，支持代码执行和文件操作 | 代码开发、文件处理 |
| **Agno** | Agno 框架，支持多种协作模式 | 对话、多智能体协作 |
| **Dify** | 外部 Dify API 代理 | Dify 工作流集成 |
| **Chat** | 直接 LLM API（无 Docker） | 轻量级对话 |

### Skills 管理

Skills 是 Claude Code 的能力扩展包：

- **上传 Skills**：打包为 ZIP 文件上传
- **管理 Skills**：查看、下载、更新、删除
- **使用 Skills**：在 Bot 中引用 Skills

---

## 🚀 配置流程

推荐的配置顺序：

1. **配置模型** → 设置 AI 模型和 API 密钥
2. **配置执行器** → 选择运行时环境
3. **上传 Skills** → 添加能力扩展（可选）
4. **创建机器人** → 组合模型、执行器和提示词
5. **创建智能体** → 组合机器人和协作模式

---

## 🔗 相关资源

- [AI 对话](../ai-chat/README.md) - 使用配置好的智能体进行对话
- [AI 知识库](../ai-knowledge/README.md) - 配置知识库检索
- [核心概念](../../concepts/core-concepts.md) - 理解 Wegent 架构
- [YAML 规范](../../reference/yaml-specification.md) - 完整配置格式
