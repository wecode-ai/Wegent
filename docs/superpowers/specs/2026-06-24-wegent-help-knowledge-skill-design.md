---
sidebar_position: 1
---

# Wegent 帮助知识库 Skill 设计

## 背景

Wegent 已经有两套相关能力：

- `backend/init_data/skills/` 可以在后端启动时创建公共 Skill，所有用户都可使用。
- 知识库系统可以存储、索引、检索文档，并通过 `wegent-knowledge` Skill 暴露给 AI Agent。

用户希望系统内置一个 Wegent 帮助能力：当用户遇到使用、配置、排错或概念理解问题时，可以直接问 AI。经过方案讨论，本设计选择“系统知识库承载文档，薄帮助 Skill 负责路由和回答约束”，而不是把文档全文复制进 Skill prompt。

## 目标

1. 打包镜像时自动收集 `docs/zh` 和 `docs/en` 的文档内容，形成可初始化的系统文档 seed。
2. 后端启动时创建一个系统级 Wegent 帮助知识库，并把系统文档导入为知识库文档。
3. 文档 seed 导入必须幂等：重复启动不产生重复知识库或重复文档。
4. 文档内容有变更时，系统能够按文档 hash 更新系统管理的文档并重新触发索引。
5. 新增 `wegent-help` 公共 Skill，默认可用但不预加载。
6. 当用户询问 Wegent 使用、配置、Agent/Bot/Skill、知识库、设备、部署或排错问题时，AI 可以按需加载 `wegent-help`。
7. `wegent-help` 指示 AI 使用知识库检索系统文档，并优先用用户提问语言回答。
8. 回答应尽量包含来源引用；当索引未就绪或无结果时，明确说明状态，不编造文档内容。

## 非目标

1. 不把全部文档正文塞入 `SKILL.md` prompt。
2. 不在 Docker build 阶段生成向量索引；索引依赖运行时数据库、检索器和 embedding 模型。
3. 不新增一套独立于知识库的文档检索 provider。
4. 不改变用户自建知识库和用户上传文档的权限模型。
5. 不默认强制预加载帮助 Skill。
6. 不在首版实现跨版本历史文档浏览或文档差异查看。

## 总体架构

```text
docs/zh + docs/en
  -> build/generate step
  -> backend/init_data/system_knowledge/wegent-help/manifest.json
  -> backend/init_data/system_knowledge/wegent-help/docs/**
  -> backend startup initialization
  -> organization/system KnowledgeBase
  -> KnowledgeDocument rows + attachments
  -> RAG indexing task
  -> wegent-help Skill
  -> wegent-knowledge MCP search/read tools
  -> AI answer with source references
```

核心原则：

- 文档是知识库数据，不是 Skill prompt。
- Skill 是入口和使用规范，不负责承载全文。
- 初始化逻辑只管理带系统来源标记的知识库和文档，不触碰用户内容。

## 系统文档 Seed

新增生成脚本，例如 `backend/scripts/generate_wegent_help_knowledge_seed.py`。脚本在打包前运行，读取：

- `docs/zh/**/*.md`
- `docs/en/**/*.md`

生成到：

```text
backend/init_data/system_knowledge/wegent-help/
├── manifest.json
└── docs/
    ├── zh/...
    └── en/...
```

`manifest.json` 包含每篇文档的稳定元数据：

```json
{
  "knowledge_base": {
    "name": "Wegent Help",
    "display_name": "Wegent 帮助文档",
    "namespace": "system",
    "description": "Built-in Wegent user and developer documentation."
  },
  "documents": [
    {
      "source_path": "docs/zh/user-guide/knowledge/knowledge-base-guide.md",
      "seed_path": "docs/zh/user-guide/knowledge/knowledge-base-guide.md",
      "language": "zh",
      "title": "使用指南",
      "category": "user-guide/knowledge",
      "content_sha256": "..."
    }
  ]
}
```

生成规则：

- 只纳入 Markdown 文档。
- 保留 frontmatter，但初始化器可读取标题时忽略 frontmatter。
- 文档名使用原路径生成稳定 display name，例如 `zh/user-guide/knowledge/knowledge-base-guide.md`。
- `content_sha256` 基于最终写入知识库的正文计算。
- 输出文件稳定排序，减少无意义 diff。

## 系统知识库初始化

新增初始化器，例如 `backend/app/core/system_knowledge_init.py`，由现有 `run_yaml_initialization()` 在 Skill 初始化后调用。

初始化器职责：

1. 读取 `INIT_DATA_DIR/system_knowledge/wegent-help/manifest.json`。
2. 确保 `system` namespace 存在，且 `level = organization`，可作为组织级知识库 namespace 被所有用户读取。
3. 确保存在一个系统管理的 `KnowledgeBase`。
4. 为 manifest 中每篇文档创建或更新 `KnowledgeDocument`。
5. 文档新增或 hash 变化时上传/更新附件并触发索引。
6. 文档缺失于新 manifest 时，首版不自动删除，只在日志中记录 orphaned system docs。

系统管理标记写入 `Kind.json.metadata.labels` 和文档 `source_config`：

```json
{
  "source": "system_knowledge_seed",
  "seed_id": "wegent-help",
  "source_path": "docs/zh/user-guide/knowledge/knowledge-base-guide.md",
  "content_sha256": "..."
}
```

知识库创建建议：

- `Kind.kind = "KnowledgeBase"`
- `Kind.user_id = <bootstrap admin user id>`
- `Kind.namespace = "system"`
- `spec.name = "Wegent Help"`
- `spec.description = "Built-in Wegent user and developer documentation."`
- `spec.kbType = "classic"`
- `spec.summaryEnabled = false`
- `spec.retrievalConfig` 尽量通过现有 auto 逻辑补齐；无法补齐时创建无 RAG 配置知识库，并记录索引不可用原因。

系统知识库不直接使用 `user_id=0` 作为 owner。公共可见性通过组织级 namespace 实现，owner 使用启动初始化阶段已经存在的 bootstrap admin 用户，这样可以复用现有知识库权限、默认模型选择和索引 owner 逻辑。

## 索引策略

RAG 索引只能在运行时执行。初始化器处理三种状态：

1. **retrievalConfig 可用**：新增或变更文档后调用现有 indexing enqueue 流程。
2. **retrievalConfig 不可用**：文档仍导入知识库，但 `wegent-help` 需要提示“系统帮助文档已导入，但检索索引未配置或未就绪”。
3. **索引中或失败**：保留知识库和文档状态，AI 回答时使用工具返回的状态说明，不假装已检索到完整结果。

首版不要求后台同步等待索引完成。启动初始化应快速返回，索引由现有 Celery/RAG pipeline 异步执行。

## Wegent Help Skill

新增内置公共 Skill：

```text
backend/init_data/skills/wegent-help/SKILL.md
```

Skill 元数据：

```yaml
---
description: "Use when users ask Wegent usage, setup, configuration, troubleshooting, Agent/Bot/Skill, knowledge base, device, deployment, or developer-documentation questions. Load this skill and search the built-in Wegent Help knowledge base before answering."
displayName: "Wegent 帮助"
version: "1.0.0"
author: "Wegent Team"
tags: ["wegent", "help", "docs", "knowledge-base", "troubleshooting"]
bindShells:
  - Chat
  - ClaudeCode
---
```

Prompt 只包含行为规则：

- 当问题属于 Wegent 产品、使用、配置、排错或开发文档范围时使用此 Skill。
- 优先调用 `wegent-knowledge` 的知识库列表和检索工具，定位系统知识库 `Wegent Help`。
- 优先使用用户提问语言回答；中文问题用中文，英文问题用英文。
- 回答时标注来源文档名称或引用工具返回的 source。
- 如果系统知识库不存在、无权限、索引未就绪或检索无结果，明确说明并给出下一步检查建议。
- 不把通用模型记忆当作文档事实来源；除非用户明确要求外部最新信息，否则不使用 web search 代替系统文档。

`wegent-help` 本身不声明新的 provider tool。它复用现有 `wegent-knowledge` Skill 的 MCP 工具。为了让默认可用体验稳定，需要在执行请求构建阶段让 `wegent-help` 与 `wegent-knowledge` 都作为公共可用 Skill 出现在普通 Chat/Code Agent 的 available skills 中，但二者都不预加载。

## 数据流

### 打包

1. 开发者或 CI 运行生成脚本。
2. 脚本读取 docs，生成 `system_knowledge/wegent-help` seed。
3. Dockerfile 现有 `COPY backend/init_data /app/init_data` 将 seed 和 Skill 一起带入镜像。

### 首次启动

1. 后端执行 YAML 和 Skill 初始化。
2. 后端执行系统知识库初始化。
3. 初始化器创建系统知识库和文档。
4. 如果 RAG 配置完整，文档进入 indexing queue。

### 用户提问

1. 用户问“Wegent 怎么配置知识库？”。
2. Agent 在 available skills 中看到 `wegent-help`，按需调用 `load_skill("wegent-help")`。
3. 根据 `wegent-help` 指令，Agent 加载或使用 `wegent-knowledge`。
4. Agent 列出或搜索知识库，锁定 `Wegent Help`。
5. Agent 使用搜索结果和来源回答用户。

## 错误处理

- **seed 文件缺失**：跳过系统知识库初始化，记录 warning，不影响后端启动。
- **manifest 格式错误**：跳过该 seed，记录 error，不影响其他 init data。
- **系统知识库已存在**：只更新系统管理字段和系统文档，不覆盖用户手动创建的其他知识库。
- **文档 hash 未变化**：跳过该文档，避免重复上传和重复索引。
- **文档 hash 变化**：更新附件内容和文档 metadata，重新触发索引。
- **缺少 retriever 或 embedding model**：创建知识库和文档，但不触发索引；Skill 回答时提示管理员配置检索能力。
- **索引失败**：不删除文档，保留失败状态，允许后续重试。
- **用户无权访问系统知识库**：这是初始化或权限配置 bug，应通过测试覆盖组织级可见性。

## 安全与权限

- 系统知识库只包含仓库内公开文档，不包含密钥或运行时配置。
- 初始化器不得扫描 `docs/` 之外的任意路径。
- manifest 中的 `seed_path` 必须校验在 seed 根目录内，避免路径穿越。
- 所有知识库访问仍走现有权限检查和 MCP task token 机制。
- 系统知识库写入只在后端启动初始化阶段发生，不暴露给普通用户作为写入口。

## 测试

后端测试：

- 生成脚本从测试 docs 目录生成稳定 `manifest.json` 和文档副本。
- manifest 中包含 title、language、category、content hash。
- 系统知识库初始化在空库中创建知识库和文档。
- 重复初始化不创建重复知识库或重复文档。
- 文档 hash 变化会更新对应文档并触发重新索引。
- 缺少 retrievalConfig 时仍导入文档，但不会 enqueue 索引。
- 系统知识库对普通用户通过 organization/all scope 可见。
- `wegent-help` Skill 可以通过 init_data skills 初始化为公共 Skill。
- 执行请求中 `wegent-help` 默认可用但不在 `preload_skills` 中。

集成测试：

- 用户提问 Wegent 帮助类问题时，available skills 包含 `wegent-help` 和 `wegent-knowledge`。
- 选中或加载 `wegent-help` 后，Agent 能检索 `Wegent Help` 知识库。
- 索引未就绪时返回明确状态提示，不生成伪引用。

## First-Version Limits

- 首版仅管理 `docs/zh` 和 `docs/en` Markdown 文件。
- 首版不自动删除 manifest 中已经移除的旧文档。
- 首版不保证启动后索引立即可用。
- 首版不新增 UI；用户通过普通对话触发帮助能力。
- 首版不实现独立文档版本管理。
