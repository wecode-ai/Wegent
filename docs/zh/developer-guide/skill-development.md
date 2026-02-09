---
sidebar_position: 8
---

# Skill 开发指南

本文档提供 Skill 系统的技术实现细节，包括架构、Provider 开发和 API 参考。

> **基础概念**：请先阅读 [Skill 系统概念](../concepts/skill-system.md) 了解基本概念。

---

## 不同 Shell 类型的 Skill 实现

Skill 系统在不同的 Shell 类型中有不同的实现方式：

| Shell 类型 | Skill 加载方式 | 特点 |
|-----------|---------------|------|
| **Chat** | 动态加载（load_skill 工具） | LLM 按需调用，提示词注入 |
| **ClaudeCode** | 预部署到文件系统 | 任务启动时下载到 ~/.claude/skills/ |

---

## Chat Shell 的 Skill 流程

### 加载流程

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

1. **ChatConfigBuilder** (`chat_shell/chat_shell/services/chat_service.py`)
   - 从 Ghost 配置中提取 skill 元数据
   - 为会话构建 skill_names 和 skill_configs

2. **系统提示词注入**
   - `append_skill_metadata_prompt()` 注入 skill 摘要
   - 格式：`- **{skill_name}**: {description}`

3. **LoadSkillTool**
   - LLM 调用的内置工具
   - 会话级缓存防止重复加载
   - 仅对公共 skill 动态加载 Provider

---

## Claude Code 的 Skill 流程

### 加载流程

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. 任务启动 - ClaudeCodeAgent 初始化                             │
│    → 从 bot_config 获取 skills 列表                              │
│    → 调用 _download_and_deploy_skills()                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. SkillDownloader 下载 Skills                                   │
│    a. 调用 Backend API 查询 skill 信息                           │
│       GET /api/v1/kinds/skills?name={skill_name}                 │
│    b. 下载 skill ZIP 包                                          │
│       GET /api/v1/kinds/skills/{skill_id}/download               │
│    c. 解压到 skills 目录                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Skills 部署完成                                               │
│    - Docker 模式: ~/.claude/skills/                              │
│    - Local 模式: {task_config_dir}/skills/                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Claude Code SDK 使用 Skills                                   │
│    - SDK 自动读取 skills 目录中的 SKILL.md                       │
│    - 用户选择的 skills 会添加强调提示词                          │
└─────────────────────────────────────────────────────────────────┘
```

### 运行模式差异

| 特性 | Docker 模式 | Local 模式 |
|-----|------------|-----------|
| Skills 目录 | `~/.claude/skills/` | `{task_config_dir}/skills/` |
| 缓存策略 | 每次清空重新部署 | 保留已有，仅下载新增 |
| `clear_cache` | `true` | `false` |
| `skip_existing` | `false` | `true` |

### 关键组件

1. **SkillDownloader** (`executor/services/api_client.py`)
   - 从 Backend API 下载 skill ZIP 包
   - 解压到指定目录
   - 支持缓存策略配置

2. **ModeStrategy** (`executor/agents/claude_code/mode_strategy.py`)
   - 定义 `get_skills_directory()` 获取 skills 目录
   - 定义 `get_skills_deployment_options()` 获取部署选项

3. **用户选择的 Skills 强调** (`executor/agents/claude_code/claude_code_agent.py`)
   - `_build_skill_emphasis_prompt()` 为用户选择的 skills 生成强调提示词
   - 提示词前缀鼓励模型优先使用这些 skills

---

## Skill Provider 系统

Provider 允许 Skills 定义在运行时动态加载的自定义工具（仅适用于 Chat Shell）。

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
from chat_shell.chat_shell.skills.provider import SkillToolProvider
from chat_shell.chat_shell.skills.context import SkillToolContext

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

### SKILL.md 中的 Provider 配置

```markdown
---
description: "图表可视化"
provider:
  module: provider                   # Python 模块名（不含 .py）
  class: MyToolProvider              # Provider 类名
tools:
  - name: tool_name
    provider: provider_name
    config:
      timeout: 30
dependencies:
  - chat_shell.chat_shell.tools.pending_requests
---
```

### SkillToolRegistry

`SkillToolRegistry` (`chat_shell/chat_shell/skills/registry.py`) 管理：
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
| `/api/tasks/{task_id}/skills` | GET | 获取任务关联的 Skills（Claude Code 使用） |

---

## 关键源文件

### Chat Shell

| 文件 | 用途 |
|------|------|
| `chat_shell/chat_shell/skills/registry.py` | SkillToolRegistry 单例 |
| `chat_shell/chat_shell/skills/provider.py` | SkillToolProvider 基类 |
| `chat_shell/chat_shell/skills/context.py` | SkillToolContext 用于工具创建 |
| `chat_shell/chat_shell/tools/skill_factory.py` | Skill 工具工厂 |

### Executor (Claude Code)

| 文件 | 用途 |
|------|------|
| `executor/services/api_client.py` | SkillDownloader 和 fetch_task_skills |
| `executor/agents/claude_code/claude_code_agent.py` | _download_and_deploy_skills 实现 |
| `executor/agents/claude_code/mode_strategy.py` | ModeStrategy 基类 |
| `executor/agents/claude_code/docker_mode_strategy.py` | Docker 模式策略 |
| `executor/agents/claude_code/local_mode_strategy.py` | Local 模式策略 |

### Backend

| 文件 | 用途 |
|------|------|
| `backend/app/schemas/kind.py` | Skill CRD schema 定义 |
| `backend/app/models/skill_binary.py` | SkillBinary SQLAlchemy 模型 |
| `backend/app/api/endpoints/kind/skills.py` | REST API 路由 |
| `backend/app/services/skill_service.py` | SkillValidator 用于 ZIP 验证 |

### 前端

| 文件 | 用途 |
|------|------|
| `frontend/src/apis/skills.ts` | API 客户端函数 |
| `frontend/src/features/settings/components/SkillListWithScope.tsx` | 带范围选择的 Skill 列表 |
| `frontend/src/features/settings/components/skills/SkillManagementModal.tsx` | Skill 管理对话框 |
| `frontend/src/features/settings/components/skills/SkillUploadModal.tsx` | Skill 上传对话框 |

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
│  Chat Shell:                                                     │
│  - Skill 元数据注入系统提示词                                     │
│  - LLM 按需调用 load_skill()                                     │
│  - Provider 加载并注册工具                                       │
│                                                                  │
│  Claude Code:                                                    │
│  - 任务启动时下载 skill ZIP 包                                   │
│  - 解压到 skills 目录                                            │
│  - Claude Code SDK 自动读取使用                                  │
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

## Provider 开发最佳实践

1. **遵循接口** - 实现所有抽象方法
2. **优雅处理错误** - 返回有意义的错误消息
3. **正确使用 context** - 从 context 访问 task_id、subtask_id、ws_emitter
4. **配置超时** - 在 tool_config 中设置合理的超时

---

## 相关文档

- [Skill 系统概念](../concepts/skill-system.md) - 基本概念和使用方式
- [核心概念](../concepts/core-concepts.md) - 所有 CRD 类型概述
- [YAML 规范](../reference/yaml-specification.md) - 完整 YAML 格式参考
