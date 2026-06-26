---
sidebar_position: 32
---

# Chat Shell 附件上下文管理（预览与按需读取）

如果需要先了解三阶段整体脉络、设计取舍和实现边界，先看
[Chat Shell 上下文治理](./chat-shell-context-governance.md)。

## 背景

用户上传的附件（PDF / Word / Excel / 图片 / 文本等）在解析后，其提取文本会作为一个独立的 `<attachment>` 文本块内联进用户消息。如果整段注入，会带来两个问题：

- **每轮常驻**：附件文本即使没触发上下文压缩，也会每轮占用大量 token；
- **压缩有损**：到达压缩阈值时，summary compact 会把整条用户消息一起折叠/截断（连提问一起砍），且不可逆。

本特性把附件的内联拷贝收敛成有界的**预览**，完整内容通过**沙箱原文**或 **`read_attachment` 工具**按需获取。

> 说明：附件解析为同步流程（上传请求内完成，默认走 `parser.py` 的 Python 库，MinerU 为知识库专用、默认关闭），所以附件进入对话即 READY，不存在“解析未完成”的竞态。

## 消息结构

装配后的用户消息是一个内容块列表，附件**独立成块**（不与提问混合，利于 prefix 缓存）：

```text
user.content = [
  {type: text,      text: "<用户提问>"},
  {type: image_url, ...},                         # 图片（若有）
  {type: text,      text: "<attachment>…</attachment>"},   # 所有附件合并在一个块
  {type: text,      text: "<knowledge_base>…</knowledge_base>"},
  {type: text,      text: "<system-reminder>…</system-reminder>"},
]
```

同一条消息的多个附件**合并在同一个 `<attachment>` 块**内，各自带 `[Attachment: name | ID: n | Type: … | File Path(already in sandbox): …]` 头。

## 注入预览（token 化）

在 `agent.build_messages` 装配消息后、缓存断点前，对每条消息里的 `<attachment>` 块做 token 预览截断（当前轮与历史轮同一处理）。实现见 `chat_shell/messages/attachment_preview.py`，复用工具输出截断逻辑（`guard/tool_output._truncate_body`，head/tail + `…N tokens truncated…` 标记）。

- **预算**：`ATTACHMENT_PREVIEW_TOKEN_LIMIT`（默认 30000，可配；`<=0` 关闭），并与窗口取小：`min(context_window // 2, 配置值)`，避免小窗口模型被预览淹没。窗口由 `get_model_context_config(model_id, model_config)` 解析。
- **快路径**：整块在预算内则原样返回，保持 prefix 缓存稳定。

### 多附件分配（water-filling）

所有附件共享一份预算（避免附件多时 N×预算爆）。预算先扣掉“块首集中 ID 列表 + 所有头部”，剩余在各段之间按 **water-filling** 分配：

- 小于公平份额的段整段保留，把余量退还池子，公平份额对剩余段重算；
- 大段吸收富余 —— 避免“小附件浪费配额、大附件被多砍”。

例：A=30k、B=5k tokens，预算 30k → B 整段保留(5k)，A 截到约 25k。每段各自 head/tail，**每个头（含 ID）都保留**；多附件时块首再加一行集中 ID 索引。

### 类型化提示

被截断的段后追加一行“如何取完整内容”的提示，按 header 里的 `Type:` 判定：

- **文本类**：`[Preview truncated. Full file readable in sandbox: <path>]` —— 沙箱原文完整，且可超过解析期截断上限；
- **二进制类（pdf/office）**：`[Preview truncated. Use read_attachment(attachment_id=N) for the full text.]` —— 沙箱里是二进制不可直读，用工具取解析后的文本。

## `read_attachment` 工具

补充预览：让模型分页读取附件的完整提取文本（主要面向二进制附件；文本附件可直接读沙箱原文）。

- **条件注册**：仅当对话（历史或当前轮）含 `<attachment>` 块时，才注册进 function-calling schema（`services/context.py`）。普通对话不注册，不走 lazy provider（那是技能系统专用）。
- **分页协议**：**char 偏移 + token 夹紧** —— 游标用字符位（与分词器无关、跨轮/跨模型可复现），返回页按 token 夹到每页预算（默认对齐工具输出 15k），保证一页不超预算、不被请求级 guard 二次截断；`next_offset = offset + 实际返回字符数`。
- **内容上界**：解析期截断（默认 50 万字符）；超出部分需读沙箱原文。
- **调用上限**：每会话上限防止无限翻页。

### 权限：按 task 收口（含群聊）

可读集合 = `{ context | context.subtask_id ∈ 本 task 的 subtasks 或未链接 }`，与历史可见性一致。

- 群聊中不同用户上传的附件 `user_id` 不同但同属一个 task，**都可读**；
- 跨 task 拒绝（403）；非 READY / 不存在返回 404。
- **不按 user 收口**（附件是对话级共享资源，区别于用户级的知识库）。

### 双路径（远程 / package）

- **HTTP/远程模式**（生产默认，backend 与 chat shell 独立部署）：经 backend 内部端点
  `GET /api/internal/chat/attachments/{id}/text?session_id=task-X&offset=&limit=`，返回字符切片 + `total_chars` / `has_more`；分页/token 夹紧在 chat shell 侧完成。
- **package 模式**：直连数据库读取，同样的 task 收口。

落点见 `chat_shell/history/attachment_text.py::fetch_attachment_text`、`chat_shell/storage/remote.py::get_attachment_text`、`backend/app/api/endpoints/internal/chat_storage.py`。

## 共享附件头（一致性）

`<attachment>` 头部由 `shared/utils/attachment_block.py::build_attachment_header` 统一构建，backend 首发预处理（`context_service` / `contexts`）与 chat shell 历史重建（`history/loader`）共用，避免首轮与翻历史后格式漂移。

## 可观测性（traces）

三个上下文防护统一通过 `chat_shell/guard/traces.py::record_protection_trace` 发 span event，事件名 `context_protection.{operation}`，schema 一致，便于在追踪后端聚合**事件数 / 成功率（按 status）/ 耗时（duration_ms）/ token 节省**：

| operation | 触发点 | status | 关键属性 |
|---|---|---|---|
| `attachment_preview` | 含附件块的消息 | `applied` / `noop` | duration_ms, before/after_tokens, tokens_saved, attachment_blocks_truncated |
| `tool_output` | 工具输出截断（仅发生时） | `applied` | duration_ms, messages_truncated, emergency |
| `summary_compact` | 请求级摘要压缩 | `completed` / `fallback` | duration_ms, before/after_tokens, tokens_saved, removed_history_items / failure_reason |

为避免噪声，空跑不发事件（`tool_output` 仅截断时发，`attachment_preview` 仅有附件块时发）；telemetry 关闭时 `add_span_event` 为 no-op。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `ATTACHMENT_PREVIEW_TOKEN_LIMIT` | 30000 | 附件预览共享预算（与 `context_window // 2` 取小）；`<=0` 关闭预览 |

## 非目标（后续档位）

- 表格 DuckDB 查询（就地查 xlsx/csv，只回结果行）；
- 散文 RAG（task 级临时索引，不暴露为用户知识库）；
- 大纲/标题寻址读；
- 视频/音频等无文本提取的类型（当前无能力）。
