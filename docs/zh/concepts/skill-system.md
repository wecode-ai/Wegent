---
sidebar_position: 3
---

# Skill 系统

## 概述

**Skill** 是一种 CRD（自定义资源定义），为 AI Agent 提供按需加载的能力和工具。与将所有指令加载到系统提示词中不同，Skill 在 LLM 判断需要时才会动态加载。

### 为什么需要 Skill？

- **Token 效率**：只在需要时加载详细指令，减少上下文窗口占用
- **模块化**：将相关的提示词和工具打包成可重用的单元
- **可扩展性**：无需修改核心 Agent 即可添加新能力

---

## Skill 与其他 CRD 的关系

```
Ghost.spec.skills[] → 引用 Skill 名称
     ↓
Bot (ghostRef) → 从 Ghost 继承 skills
     ↓
Team (members[]) → Bot 的 skills 在任务中可用
     ↓
Task 执行 → LLM 按需调用 load_skill()
```

**要点：**
- Skills 通过名称在 `Ghost.spec.skills[]` 中引用
- 一个 Ghost 可以有多个 skills
- Skills 可以是用户私有的或公共的
- 查找优先级：用户私有 Skills 优先，然后是公共 Skills

---

## Skill 包结构

Skills 以 ZIP 包形式上传，包含：

```
skill-package.zip
├── SKILL.md          # 必需：元数据 + 提示词内容
└── *.py              # 可选：其他工具模块
```

### SKILL.md 格式

SKILL.md 文件使用 YAML frontmatter 作为元数据，markdown 正文作为提示词内容：

```markdown
---
description: "简短描述 - LLM 用于决定何时加载"
displayName: "人类可读名称"
version: "1.0.0"
author: "作者名"
tags: ["标签1", "标签2"]
bindShells: ["Chat", "ClaudeCode"]  # 兼容的 Shell 类型
---

# Skill 提示词内容

当 LLM 加载此 skill 时，这些详细指令将被注入到系统提示词中...
```

### 元数据字段

| 字段 | 必需 | 描述 |
|------|------|------|
| `description` | 是 | LLM 决定何时加载的简短描述 |
| `displayName` | 否 | UI 显示的人类可读名称 |
| `version` | 否 | 语义化版本号 |
| `author` | 否 | 作者名 |
| `tags` | 否 | 分类标签 |
| `bindShells` | 否 | 兼容的 Shell 类型（如 "Chat", "ClaudeCode"） |

---

## Skill 工作流程

1. **创建 Skill**：用户上传包含 SKILL.md 的 ZIP 包
2. **配置关联**：将 skill 名称添加到 Ghost.spec.skills[]
3. **运行时加载**：
   - 任务启动时，skill 元数据（名称和描述）注入系统提示词
   - LLM 根据用户请求判断是否需要加载某个 skill
   - 调用 `load_skill()` 工具加载完整的 skill 提示词
4. **更新/删除**：可以上传新版本或删除（需先解除 Ghost 引用）

---

## 最佳实践

### 创建 Skills

1. **编写清晰的描述** - 描述被 LLM 用于决定何时加载，应简洁明了
2. **保持提示词聚焦** - 每个 skill 应有单一、明确的用途
3. **使用合适的 bindShells** - 指定兼容的 Shell 类型
4. **为 skill 添加版本** - 使用语义化版本追踪变更

---

## 相关文档

- [核心概念](./core-concepts.md) - 所有 CRD 类型概述
- [YAML 规范](../reference/yaml-specification.md) - 完整 YAML 格式参考
- [Skill 开发指南](../developer-guide/skill-development.md) - 技术实现细节和 Provider 开发

---

<p align="center">更多信息请参见 <a href="../../../AGENTS.md">AGENTS.md</a> 开发指南。</p>
