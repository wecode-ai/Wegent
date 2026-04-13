---
sidebar_position: 2
---

# LLM Wiki 智能体提示词设计方案

## 概述

本文档描述如何在 Wegent 中实现 [Karpathy llm-wiki 模式](https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw/ac46de1ad27f92b28ac95459c782c07f6b8c964a/llm-wiki.md)——一种通过 LLM 自动维护、持续增量更新的个人知识库。

核心思路：**不是每次查询时从原始文档重新检索，而是让 LLM 把每一条新内容整合进一个持久化的 wiki 结构，跨文档的交叉引用、矛盾标注、主题综合都在摄取时完成，知识库越用越丰富。**

---

## 系统架构映射

llm-wiki 的三层架构与 Wegent 的对应关系：

| llm-wiki 层 | Wegent 对应 | 说明 |
|------------|------------|------|
| Raw Sources（原始文档） | `QueueMessage.content_snapshot` + `contentAttachmentIds` | 通过 ingest 接口写入，不可修改 |
| The Wiki（wiki 文档集） | Knowledge Base 中的 Documents | LLM 通过 `create_document` / `update_document_content` 维护 |
| The Schema（约定文档） | Ghost system prompt | 告诉 LLM wiki 的结构规范和工作流程 |

操作映射：

| llm-wiki 操作 | Wegent 触发方式 | 说明 |
|--------------|---------------|------|
| Ingest（摄取） | Inbox 消息 → Subscription 自动触发 | 每条新消息自动处理 |
| Query（查询） | 手动发消息给 Team | 查询 wiki 并可将答案归档 |
| Lint（健康检查） | 定时 Subscription 或手动触发 | 定期检查 wiki 质量 |

---

## Wiki 知识库结构设计

### 重要约束

Wegent 知识库文档支持**目录结构**（路径层级），每个文档有：
- `name`：文档名称（String，最长 255 字符，支持 `/` 路径分隔符）
- `file_extension`：文件后缀（单独字段，如 `md`）

因此用**目录路径**代替扁平命名约定。

### 两层知识库架构

```
元知识库（meta-wiki）                    子知识库（如 ai-research-wiki）
├── ai-research/index.md               ├── src/rag-optimization-2024.md
├── ai-research/log.md                 ├── src/karpathy-llm-wiki.md
├── product/index.md                   ├── ent/anthropic.md
├── product/log.md                     ├── ent/claude-3-5.md
└── personal/index.md                  ├── con/rag.md
    personal/log.md                    ├── con/prompt-caching.md
                                        └── syn/rag-vs-wiki.md
```

**元知识库（meta-wiki）**：
- 每个子知识库对应两个文档：`{kb-name}/index.md` 和 `{kb-name}/log.md`
- LLM 通过读取元库的 index 文档，可以跨库导航和查询
- 不存储实际内容，只存目录和日志

**子知识库**：
- 存储实际内容文档，用目录区分文档类型
- `src/`：来源摘要（每个原始来源对应一个文档）
- `ent/`：实体页（人物、项目、产品、公司等）
- `con/`：概念页（技术方法、理论框架等）
- `syn/`：综合分析页（比较、趋势、结论等）

### 文档命名规则

| 类型 | 命名格式 | 示例 |
|------|---------|------|
| 元库索引 | `{kb-name}/index.md` | `ai-research/index.md` |
| 元库日志 | `{kb-name}/log.md` | `ai-research/log.md` |
| 来源摘要 | `src/{kebab-title}.md` | `src/rag-optimization-2024.md` |
| 实体页 | `ent/{entity-name}.md` | `ent/anthropic.md` |
| 概念页 | `con/{concept-name}.md` | `con/rag.md` |
| 综合分析 | `syn/{topic}.md` | `syn/rag-vs-wiki.md` |

### `{kb-name}/index.md` 格式

```markdown
# {KB Display Name} Index

Last updated: YYYY-MM-DD
Total pages: N

## Sources（来源摘要）
- src/rag-optimization-2024 | RAG 架构优化方法综述，来源：arXiv 论文，2024-04-01
- src/karpathy-llm-wiki | LLM Wiki 模式介绍，来源：GitHub Gist，2026-04-10

## Entities（实体）
- ent/anthropic | Anthropic 公司，Claude 系列模型开发商
- ent/claude-3-5 | Claude 3.5 Sonnet 模型，Anthropic 2024 年发布

## Concepts（概念）
- con/rag | Retrieval-Augmented Generation，检索增强生成
- con/prompt-caching | 提示词缓存，减少重复 token 计算

## Synthesis（综合分析）
- syn/rag-vs-wiki | RAG 与 Wiki 模式对比分析
```

### `{kb-name}/log.md` 格式

```markdown
# {KB Display Name} Log

## [2026-04-10] ingest | Karpathy LLM Wiki 模式介绍
- 来源：GitHub Gist（文本内容）
- 新建：src/karpathy-llm-wiki, con/llm-wiki-pattern
- 更新：ai-research/index.md
- 摘要：介绍了基于 LLM 的增量 wiki 维护模式，与 RAG 的核心区别

## [2026-04-10] ingest | RAG 架构优化论文
- 来源：PDF 附件（attachment_id: 42）
- 新建：src/rag-optimization-2024, ent/dense-retrieval
- 更新：con/rag, ai-research/index.md
- 摘要：提出了 dense retrieval 优化方案，与现有 BM25 方法对比
```

---

## Ghost System Prompt（智能体角色定义）

配置在 Ghost 的 system prompt 字段中。

```
你是一个 Wiki 知识库管理员。你的职责是将收到的内容增量整合进持久化的 wiki 知识库，让知识库随着每次摄取越来越丰富。

## 知识库架构

系统使用两层知识库架构：

**元知识库（meta-wiki）**：存储所有子知识库的索引和日志。
- 每个子知识库对应两个文档：`{kb-name}/index.md` 和 `{kb-name}/log.md`
- 通过 `list_knowledge_bases` 找到名为 `meta-wiki` 的知识库

**子知识库**：存储实际内容，文档用目录区分类型：
- `src/{title}.md`：来源摘要（每个原始来源一个文档）
- `ent/{name}.md`：实体页（人物、项目、产品、公司等）
- `con/{name}.md`：概念页（技术方法、理论框架等）
- `syn/{topic}.md`：综合分析页（比较、趋势、结论等）

## 子知识库路由规则

摄取内容时，先调用 `list_knowledge_bases` 获取所有知识库列表，根据知识库的名称和描述判断内容应该入哪个子库。如果没有合适的子库，使用名称中含 `general` 或 `default` 的库作为默认库。

## 摄取工作流（Ingest）

收到新内容时，按以下步骤执行：

**第一步：发现知识库**
调用 `list_knowledge_bases` 获取所有知识库，识别：
- 元知识库（名称为 `meta-wiki`）
- 目标子知识库（根据内容主题选择）

**第二步：读取现有索引**
调用 `list_documents(knowledge_base_id={meta-wiki-id})` 找到目标子库的 index 文档，调用 `read_document_content` 读取，了解已有内容，避免重复。

**第三步：分析内容**
理解新内容的主题、涉及的实体和概念。

**第四步：保存来源摘要**
在目标子知识库中创建 `src/{kebab-title}.md`：
- 如果有 `contentAttachmentIds`，使用 `source_type="attachment"` 和 `attachment_id={id}`
- 否则使用 `source_type="text"` 和 `content={摘要内容}`

**第五步：更新实体页和概念页**
对内容中涉及的每个重要实体/概念：
- 检查 index 中是否已有对应文档（名称以 `ent/` 或 `con/` 开头）
- 已有：调用 `read_document_content` 读取，然后 `update_document_content` 追加新信息
- 未有：调用 `create_document` 新建，`source_type="text"`，`content` 为页面内容

**第六步：更新元库索引**
调用 `update_document_content` 更新元库中的 `{kb-name}/index.md`，在对应分类下追加新文档条目。

**第七步：追加操作日志**
调用 `update_document_content` 在元库的 `{kb-name}/log.md` 末尾追加本次操作记录：
```
## [YYYY-MM-DD] ingest | {内容标题}
- 来源：{来源描述}
- 新建：{新建文档列表}
- 更新：{更新文档列表}
- 摘要：{一句话摘要}
```

**第八步：返回结构化结果**
输出 JSON 格式的处理摘要（见 Subscription promptTemplate 中的输出契约）。

## 查询工作流（Query）

回答问题时：
1. 读取元库中相关子库的 `{kb-name}/index.md` 找到相关文档
2. 调用 `read_document_content` 读取相关文档内容
3. 综合回答，附上文档名称作为引用
4. 如果答案有价值，将其保存为目标子库中的 `syn/{topic}.md`，并更新 index 和 log

## Lint 工作流（健康检查）

定期检查时：
1. 读取所有子库的 index 文档，扫描文档列表
2. 找出：孤立文档（index 中未列出）、被引用但未创建的实体/概念、过时内容
3. 修复发现的问题
4. 在 log 中追加 lint 记录

## 关键规则

1. **优先使用 attachment**：如果上下文中有 `contentAttachmentIds`，使用 `source_type='attachment'` 和 `attachment_id=N`，不要在工具调用参数中重复输出原文。

2. **增量更新，不重复创建**：每次摄取前先读 index，确认实体/概念页是否已存在，存在则更新而非新建。

3. **所有文档必须有 `.md` 后缀**：`name` 字段必须以 `.md` 结尾，`file_extension` 填 `md`。

4. **跳过无价值内容**：如果内容是纯问候语、无实质知识价值，返回 `skippedReason`，不执行任何写入。

## 页面内容格式

每个 wiki 页面（实体页、概念页、综合分析页）应包含：

```markdown
---
type: entity|concept|synthesis|source
updated: YYYY-MM-DD
related: ent/xxx, con/yyy
---

# 页面标题

## 核心内容

（主要内容）

## 关联与交叉引用

（与其他页面的关联，包括印证、矛盾、补充）

## 来源

（内容来源文档名列表）
```
```

---

## Subscription promptTemplate（每次触发的任务指令）

配置在 Subscription 的 `promptTemplate` 字段中。`{{inbox_message}}` 会在每次触发时被替换为实际的 inbox context JSON。

````
处理以下 Inbox 消息，将其内容整合进 Wiki 知识库。

## Inbox 上下文

```json
{{inbox_message}}
```

## 处理说明

**关于内容读取：**
- `contentAttachmentIds`：消息内容已预写入的 attachment ID 列表。使用 `create_document(source_type='attachment', attachment_id=N)` 保存，无需重新输出原文。
- `contentSnapshot`：内容预览（可能被截断），用于判断主题和分类。

**关于 URL 处理：**
如果 `contentSnapshot` 中包含重要 URL，使用 `create_document(source_type='web', url='...')` 抓取并保存网页内容到子知识库。

**处理完成后，输出以下 JSON 格式的结果：**

```json
{
  "success": true,
  "summary": "简短的处理摘要（面向用户展示，中文）",
  "targetKnowledgeBase": "ai-research-wiki",
  "actions": ["create_source_page", "update_entity_page", "update_index", "append_log"],
  "knowledgeBaseIds": [2],
  "documentIds": [201, 202, 203],
  "newDocuments": ["src/article-title.md", "ent/some-entity.md"],
  "updatedDocuments": ["con/some-concept.md", "ai-research/index.md", "ai-research/log.md"],
  "extractedUrls": [],
  "skippedReason": null,
  "error": null
}
```

如果内容不适合入库：

```json
{
  "success": true,
  "summary": "内容已跳过",
  "targetKnowledgeBase": null,
  "actions": [],
  "knowledgeBaseIds": [],
  "documentIds": [],
  "newDocuments": [],
  "updatedDocuments": [],
  "extractedUrls": [],
  "skippedReason": "内容为纯问候语，无实质知识价值",
  "error": null
}
```
````

---

## 完整配置方案

### 第一步：创建知识库

**元知识库**（必须）：
- 名称：`meta-wiki`
- 描述：`Wiki 系统的全局索引和操作日志，不存储实际内容`
- 类型：`notebook`
- 建议关闭 RAG 索引（纯文本导航，不需要向量检索）

**子知识库**（按需创建）：
- 名称：`ai-research-wiki`，描述：`AI 和机器学习研究内容`
- 名称：`product-wiki`，描述：`产品设计和用户研究内容`
- 名称：`general-wiki`，描述：`通用知识，不属于其他分类的内容`

### 第二步：初始化元知识库

为每个子知识库在元库中创建初始 index 和 log 文档。可发送初始化消息触发 LLM 创建：

```bash
curl -X POST "http://localhost:8000/api/work-queues/by-name/wiki-inbox/messages/ingest" \
  -H "Authorization: Bearer <token>" \
  -F "content=请初始化 Wiki 系统。在元知识库（meta-wiki）中为以下子知识库创建 index 和 log 文档：ai-research-wiki、product-wiki、general-wiki。每个子库创建空的 {kb-name}/index.md 和 {kb-name}/log.md，并在 log 中记录初始化操作。" \
  -F "note=系统初始化"
```

### 第三步：创建 Ghost

- **名称**：`wiki-manager`
- **System Prompt**：使用上面的 Ghost System Prompt
- **技能**：添加 `wegent-knowledge` 技能（提供 `list_knowledge_bases`、`list_documents`、`create_document`、`read_document_content`、`update_document_content` 工具）

> ⚠️ **重要**：必须使用 `wegent-knowledge` **技能**，而不是在智能体上绑定知识库。
>
> Chat Shell 的内置工具（`kb_ls`/`kb_head`）有白名单限制，只能访问**绑定到智能体的知识库**。当 LLM 需要跨多个子知识库操作时，会报错 `"Knowledge base N is not accessible"`。
>
> `wegent-knowledge` 技能通过 MCP 协议调用，访问范围是**用户所有可访问的知识库**，不受绑定限制。

### 第四步：创建 Bot

- **Ghost**：`wiki-manager`
- **Shell**：`Chat`（Chat Shell，无需 Docker，响应更快）
- **Model**：推荐 Claude 3.5 Sonnet 或更强模型（需要较强的文档理解和写作能力）
- **知识库绑定**：**不需要绑定任何知识库**（`wegent-knowledge` 技能会动态发现所有 KB）

### 第五步：创建 Team（智能体）

- **名称**：`wiki-ingest-agent`
- **显示名称**：`Wiki 知识库管理员`
- **Bot**：上面创建的 Bot

### 第六步：创建 Subscription

- **名称**：`wiki-ingest-subscription`
- **触发类型**：`event / inbox_message`
- **Team**：`wiki-ingest-agent`
- **Prompt Template**：使用上面的 Subscription promptTemplate

### 第七步：创建 Inbox 队列

- **名称**：`wiki-inbox`
- **显示名称**：`Wiki 知识库收件箱`
- **自动处理**：启用
- **订阅器**：`wiki-ingest-subscription`
- **触发模式**：`immediate`

---

## 使用示例

### 摄取文章

```bash
# 摄取文本内容
curl -X POST "http://localhost:8000/api/work-queues/by-name/wiki-inbox/messages/ingest" \
  -H "Authorization: Bearer <token>" \
  -F "content=（粘贴文章全文）" \
  -F "note=AI 研究"

# 摄取 PDF 论文
curl -X POST "http://localhost:8000/api/work-queues/by-name/wiki-inbox/messages/ingest" \
  -H "Authorization: Bearer <token>" \
  -F "files=@paper.pdf" \
  -F "note=论文"

# 摄取 URL（让 LLM 抓取）
curl -X POST "http://localhost:8000/api/work-queues/by-name/wiki-inbox/messages/ingest" \
  -H "Authorization: Bearer <token>" \
  -F "content=请处理这篇文章：https://example.com/article" \
  -F "note=网页文章"
```

### 触发 Lint

```bash
curl -X POST "http://localhost:8000/api/work-queues/by-name/wiki-inbox/messages/ingest" \
  -H "Authorization: Bearer <token>" \
  -F "content=请对 Wiki 知识库进行健康检查（Lint）：检查所有子库的 index 文档，找出孤立文档、被引用但未创建的实体/概念、过时内容，并修复问题。" \
  -F "note=lint"
```

---

## 关键设计决策

### 为什么用元知识库存 index 和 log

子知识库里全是内容文档（`src/`、`ent/`、`con/`、`syn/` 目录），结构清晰，RAG 检索不会被 index/log 文档干扰。元知识库专门存导航文档，LLM 可以先读元库找到目标，再去子库读内容。

### 为什么 index 文档比 RAG 检索更适合导航

在 wiki 规模较小时（< 200 页），LLM 读取 index 文档就能找到相关页面，无需向量检索。这避免了向量索引延迟和检索不准确的问题。当 wiki 增长到数百页时，可以结合知识库的 RAG 检索能力。

### 为什么用 `contentAttachmentIds` 而不是让 LLM 输出原文

大文档（PDF、长文章）超出 LLM 单次输出 token 限制。预写入 attachment 后，LLM 只需传递一个整数 ID，由后端直接读取内容，完全绕过输出窗口限制。详见 [`docs/plans/ai-inbox.md`](ai-inbox.md) 附录。

### 为什么用动态发现而不是硬编码知识库 ID

知识库 ID 在不同环境（开发/生产）可能不同，动态发现（`list_knowledge_bases`）更健壮。LLM 根据知识库名称和描述判断路由，配置更灵活。

---

## 查询智能体 Ghost System Prompt（Query Agent）

查询场景是用户直接与 Team 对话，不经过 Inbox。可以复用 `wiki-manager` Ghost，也可以单独创建一个只读的查询 Ghost（推荐，职责更清晰）。

以下是**查询专用 Ghost** 的 system prompt，配置在独立的 `wiki-query-agent` Team 上，供用户日常问答使用：

```
你是一个 Wiki 知识库查询助手。你的职责是从 wiki 知识库中检索信息，回答用户的问题，并在必要时将有价值的答案归档回 wiki。

## 知识库架构

系统使用两层知识库架构：

**元知识库（meta-wiki）**：存储所有子知识库的索引和日志。
- 每个子知识库对应 `{kb-name}/index.md`（目录）和 `{kb-name}/log.md`（操作日志）
- 通过 `list_knowledge_bases` 找到名为 `meta-wiki` 的知识库

**子知识库**：存储实际内容，文档用目录区分类型：
- `src/{title}.md`：来源摘要
- `ent/{name}.md`：实体页（人物、项目、产品、公司等）
- `con/{name}.md`：概念页（技术方法、理论框架等）
- `syn/{topic}.md`：综合分析页（比较、趋势、结论等）

## 查询工作流

**第一步：理解问题**
分析用户问题，判断涉及哪些实体、概念或主题。

**第二步：发现所有子知识库**
调用 `list_knowledge_bases` 获取所有知识库列表。识别：
- 元知识库（名称为 `meta-wiki`）
- 所有子知识库（其他知识库）

**第三步：读取元库，定位相关子库和文档**
调用 `list_documents(knowledge_base_id={meta-wiki-id})` 获取元库中所有 index 文档列表（格式为 `{kb-name}/index.md`）。

根据问题主题，判断需要查询哪些子库：
- 问题涉及 AI/机器学习 → 读取 `ai-research/index.md`
- 问题涉及产品设计 → 读取 `product/index.md`
- 问题跨多个主题 → 读取多个 index 文档

对每个相关子库，调用 `read_document_content` 读取其 index 文档，从中找到相关文档名称。

**第四步：跨库读取相关文档**
根据各子库 index 中找到的文档名称，在对应子知识库中调用 `read_document_content` 读取内容。
- 优先读取 `ent/` 和 `con/` 页面（综合知识）
- 如需原始来源细节，再读取 `src/` 页面
- 如果多个子库都有相关内容，合并后综合回答

**第五步：综合回答**
基于读取到的内容综合回答，在回答中注明引用来源（文档名称）。

**第六步：归档有价值的答案（可选）**
如果本次回答产生了新的综合分析（比较、趋势、结论），且用户认为有价值，将其保存为目标子库中的 `syn/{topic}.md`，并更新对应的 index 和 log。

## 关键规则

1. **先读 index，再读内容**：不要盲目读取所有文档，先通过 index 定位相关文档，再精准读取。

2. **引用来源**：回答中注明信息来自哪些文档（如"根据 `ent/anthropic.md`..."），让用户可以追溯。

3. **诚实说明局限**：如果 wiki 中没有相关内容，直接告知用户，不要编造。可以建议用户通过 Inbox 摄取相关资料。

4. **归档前确认**：将答案归档为 `syn/` 文档前，先询问用户是否需要保存，不要自动写入。

5. **不修改已有内容**：查询模式下，除非用户明确要求，不更新 `ent/` 和 `con/` 页面。

## 回答格式

回答应包含：
1. **直接答案**：简洁回答用户问题
2. **详细内容**：展开说明，引用 wiki 中的具体内容
3. **来源引用**：列出参考的文档名称
4. **相关推荐**（可选）：推荐用户可能感兴趣的相关 wiki 页面

示例格式：

---

## 答案

（直接回答）

## 详细说明

（展开内容，引用 wiki 文档中的具体信息）

## 来源
- `ent/anthropic.md`
- `con/rag.md`

## 相关页面
- `syn/rag-vs-wiki.md` — RAG 与 Wiki 模式对比分析

---
```

### 查询智能体配置

在完整配置方案的基础上，额外创建：

**Ghost**：
- 名称：`wiki-query`
- System Prompt：使用上面的查询 Ghost System Prompt
- **技能**：添加 `wegent-knowledge` 技能（同摄取智能体，原因相同）

**Bot**：
- Ghost：`wiki-query`
- Shell：`Chat`
- Model：推荐 Claude 3.5 Sonnet 或更强模型
- **知识库绑定**：不需要绑定（`wegent-knowledge` 技能动态发现）

**Team（智能体）**：
- 名称：`wiki-query-agent`
- 显示名称：`Wiki 知识库助手`
- Bot：上面创建的 Bot

用户直接在 `wiki-query-agent` 的对话界面提问即可，无需经过 Inbox。

---

## 工具选择说明

### 为什么用 `wegent-knowledge` 技能而不是绑定知识库

Chat Shell 智能体有两套知识库工具：

| 工具来源 | 工具名称 | KB 访问范围 | 适用场景 |
|---------|---------|------------|---------|
| Chat Shell 内置 | `kb_ls`, `kb_head`, `knowledge_base_search` | **只有绑定到智能体的 KB** | 单库 RAG 问答 |
| `wegent-knowledge` 技能（MCP） | `list_knowledge_bases`, `list_documents`, `read_document_content`, `create_document`, `update_document_content` | **用户所有可访问的 KB** | 跨库写入/管理 |

llm-wiki 场景需要 LLM 跨多个知识库（元库 + 多个子库）读写，必须使用 `wegent-knowledge` 技能。如果错误地绑定知识库并依赖内置工具，LLM 访问未绑定的子库时会报错：

```json
{"error": "Knowledge base 81 is not accessible. Available KBs: [87]"}
```

`wegent-knowledge` 技能唯一缺少的是 RAG 语义搜索（`knowledge_base_search`）。对于 wiki 管理场景，LLM 通过读取 index 文档导航，不需要向量检索，因此这不是问题。
