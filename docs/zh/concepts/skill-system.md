# 🎯 Skill 系统架构

本文档提供了 Wegent 中 Skill 系统的全面指南，涵盖架构、实现细节和开发指南。

---

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
- Skills 可以是用户私有的（user_id > 0）或公共的（user_id = 0）
- 查找优先级：用户私有 Skills 优先，然后是公共 Skills

---

## Skill 包结构

Skills 以 ZIP 包形式上传，包含：

```
skill-package.zip
├── SKILL.md          # 必需：元数据 + 提示词内容
├── provider.py       # 可选：工具提供者实现
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
provider:
  module: provider                   # Python 模块名（不含 .py）
  class: MyToolProvider              # Provider 类名
tools:
  - name: tool_name
    provider: provider_name
    config:
      timeout: 30
dependencies:
  - app.chat_shell.tools.pending_requests
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
| `provider` | 否 | 动态工具的 Provider 配置 |
| `tools` | 否 | 工具声明 |
| `dependencies` | 否 | Python 模块依赖 |

---

## Skill 加载流程

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. 任务启动 - ChatConfigBuilder 构建配置                         │
│    → 从 Ghost.spec.skills 提取 skill 元数据                      │
│    → 将 skill 摘要注入系统提示词                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. 系统提示词包含：                                              │
│    "## Available Skills                                         │
│    - **skill_name**: description (call load_skill to use)"      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. LLM 决定加载 Skill                                            │
│    → 调用 load_skill(skill_name="xxx") 工具                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. LoadSkillTool 执行                                            │
│    a. 查找 Skill（用户私有优先，然后公共）                        │
│    b. 从 SKILL.md 提取完整提示词                                 │
│    c. 动态加载 Provider（仅公共 Skill）                           │
│    d. 向 SkillToolRegistry 注册工具                              │
│    e. 缓存已加载的 skill                                         │
└─────────────────────────────────────────────────────────────────┘
```

### 实现细节

1. **ChatConfigBuilder** (`backend/app/services/chat_v2/config/chat_config.py`)
   - 从 Ghost 配置中提取 skill 元数据
   - 为会话构建 skill_names 和 skill_configs

2. **系统提示词注入** (`backend/app/services/chat_v2/utils/prompts.py`)
   - `append_skill_metadata_prompt()` 注入 skill 摘要
   - 格式：`- **{skill_name}**: {description}`

3. **LoadSkillTool** (`backend/app/services/chat_v2/tools/builtin/load_skill.py`)
   - LLM 调用的内置工具
   - 会话级缓存防止重复加载
   - 仅对公共 skill 动态加载 Provider

---

## Skill Provider 系统

Provider 允许 Skills 定义在运行时动态加载的自定义工具。

### Provider 接口

```python
from abc import ABC, abstractmethod
from typing import Any, Optional
from langchain_core.tools import BaseTool

class SkillToolProvider(ABC):
    """Skill 工具提供者基类。"""

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Provider 的唯一标识符。"""
        pass

    @property
    @abstractmethod
    def supported_tools(self) -> list[str]:
        """此 Provider 支持的工具名称列表。"""
        pass

    @abstractmethod
    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """创建工具实例。"""
        pass
```

### Provider 实现示例

```python
from app.chat_shell.skills.provider import SkillToolProvider
from app.chat_shell.skills.context import SkillToolContext

class MermaidToolProvider(SkillToolProvider):
    @property
    def provider_name(self) -> str:
        return "mermaid"

    @property
    def supported_tools(self) -> list[str]:
        return ["render_mermaid"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        config = tool_config or {}
        from .render_mermaid import RenderMermaidTool
        return RenderMermaidTool(
            task_id=context.task_id,
            subtask_id=context.subtask_id,
            ws_emitter=context.ws_emitter,
            render_timeout=config.get("timeout", 30.0),
        )
```

### SkillToolRegistry

`SkillToolRegistry` (`backend/app/services/chat_v2/skills/registry.py`) 管理：
- Provider 注册和查找（单例，线程安全）
- 从 ZIP 包动态加载 Provider
- 为 skills 创建工具实例

### 安全考虑

⚠️ **重要：** 只有公共 Skills（user_id=0）可以从 provider 加载动态代码。用户上传的 Skills 只能提供提示词内容。这可以防止用户上传恶意代码执行。

---

## 数据库存储

### 表

| 表 | 用途 |
|----|------|
| `kinds` | Skill CRD 元数据（与其他 CRD 相同） |
| `skill_binaries` | ZIP 包二进制存储 |

### skill_binaries 表结构

```sql
CREATE TABLE skill_binaries (
    id INT PRIMARY KEY AUTO_INCREMENT,
    kind_id INT NOT NULL,              -- 引用 kinds.id
    binary_data LONGBLOB NOT NULL,     -- ZIP 包内容
    file_size INT NOT NULL,            -- 文件大小（字节）
    file_hash VARCHAR(64) NOT NULL,    -- SHA256 哈希
    created_at DATETIME,
    FOREIGN KEY (kind_id) REFERENCES kinds(id) ON DELETE CASCADE
);
```

---

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/skills/upload` | POST | 上传 Skill ZIP 包 |
| `/skills` | GET | 列出当前用户的 Skills |
| `/skills/unified` | GET | 列出用户 + 公共 Skills |
| `/skills/public/list` | GET | 列出公共 Skills |
| `/skills/public` | POST | 创建公共 Skill（仅管理员） |
| `/skills/invoke` | POST | 获取 Skill 提示词内容 |
| `/skills/{skill_id}` | GET | 获取 Skill 详情 |
| `/skills/{skill_id}/download` | GET | 下载 Skill ZIP 包 |
| `/skills/{skill_id}` | PUT | 更新 Skill |
| `/skills/{skill_id}` | DELETE | 删除 Skill（检查引用） |

---

## 关键源文件

### 后端

| 文件 | 用途 |
|------|------|
| `app/schemas/kind.py` | Skill CRD schema 定义（SkillSpec, SkillToolDeclaration 等） |
| `app/models/skill_binary.py` | SkillBinary SQLAlchemy 模型 |
| `app/api/endpoints/kind/skills.py` | REST API 路由 |
| `app/services/skill_service.py` | SkillValidator 用于 ZIP 验证 |
| `app/services/adapters/skill_kinds.py` | CRUD 操作 |
| `app/services/adapters/public_skill.py` | 公共 Skill 管理 |
| `app/services/chat_v2/tools/builtin/load_skill.py` | LoadSkillTool 实现 |
| `app/services/chat_v2/skills/registry.py` | SkillToolRegistry 单例 |
| `app/services/chat_v2/skills/provider.py` | SkillToolProvider 基类 |
| `app/services/chat_v2/skills/context.py` | SkillToolContext 用于工具创建 |
| `app/services/chat_v2/config/chat_config.py` | ChatConfigBuilder skill 提取 |
| `app/services/chat_v2/utils/prompts.py` | 提示词注入工具 |

### 前端

| 文件 | 用途 |
|------|------|
| `src/apis/skills.ts` | API 客户端函数 |
| `src/features/settings/components/SkillListWithScope.tsx` | 带范围选择的 Skill 列表 |
| `src/features/settings/components/skills/SkillManagementModal.tsx` | Skill 管理对话框 |
| `src/features/settings/components/skills/SkillUploadModal.tsx` | Skill 上传对话框 |

---

## 内置 Skills

位于 `backend/init_data/skills/`：

| Skill | 描述 |
|-------|------|
| `mermaid-diagram` | 使用 Mermaid.js 进行图表可视化 |
| `wiki_submit` | Wiki 提交能力 |

---

## Skill 生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│                     1. 创建 Skill                                │
│  - 用户上传 ZIP 包                                               │
│  - 验证 SKILL.md 格式并提取元数据                                │
│  - 存储到 kinds 表和 skill_binaries 表                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     2. 配置关联                                   │
│  - 将 skill 名称添加到 Ghost.spec.skills[]                       │
│  - Ghost 被 Bot 引用                                             │
│  - Bot 被 Team 引用                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     3. 运行时加载                                 │
│  - 用户创建使用 Team 的 Task                                     │
│  - ChatConfigBuilder 提取 skills                                 │
│  - Skill 元数据注入系统提示词                                     │
│  - LLM 按需调用 load_skill()                                     │
│  - Provider 加载并注册工具                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     4. 更新/删除                                  │
│  - 更新：上传新 ZIP，元数据更新                                   │
│  - 删除：先检查 Ghost 引用，如有引用则拒绝                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 最佳实践

### 创建 Skills

1. **编写清晰的描述** - 描述被 LLM 用于决定何时加载
2. **保持提示词聚焦** - 每个 skill 应有单一、明确的用途
3. **使用合适的 bindShells** - 指定兼容的 Shell 类型
4. **为 skill 添加版本** - 使用语义化版本追踪变更

### Provider 开发

1. **遵循接口** - 实现所有抽象方法
2. **优雅处理错误** - 返回有意义的错误消息
3. **正确使用 context** - 从 context 访问 task_id、subtask_id、ws_emitter
4. **配置超时** - 在 tool_config 中设置合理的超时

---

## 相关文档

- [核心概念](./core-concepts.md) - 所有 CRD 类型概述
- [YAML 规范](../reference/yaml-specification.md) - 完整 YAML 格式参考
- [架构](./architecture.md) - 系统架构概述

---

<p align="center">更多信息请参见 <a href="../../../AGENTS.md">AGENTS.md</a> 开发指南。</p>
