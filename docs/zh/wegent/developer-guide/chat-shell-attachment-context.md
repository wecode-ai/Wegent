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

## 注入截断（backend，字符级，所有模式）

提取文本先在 backend 注入层（`context_service.build_document_text_prefix`）按**字符**截断到 `ATTACHMENT_INJECT_MAX_CHARS`（默认 32000），再进入各模式的 prompt。这是**存储**与**注入**的分离：

- **存储**：完整提取文本（≤ `MAX_EXTRACTED_TEXT_LENGTH`，默认 50 万字符）留在 DB，供 `read_attachment` 分页、executor/device 下载真文件；
- **注入**：进 prompt 的是有界预览（连续 head + tail + 单个标记，指向 header 里的完整文件）。

这层对**所有模式**生效，是 executor / device（无 chat shell token 预览）唯一的注入长度护栏。chat shell 会在其上再做一道 token 级预览（见下）。

## 注入预览（token 化，chat shell）

在 `agent.build_messages` 装配消息后、缓存断点前，对每条消息里的 `<attachment>` 块做 token 预览截断（当前轮与历史轮同一处理；在上面 backend 字符截断之上再精修）。实现见 `chat_shell/messages/attachment_preview.py`，复用工具输出截断逻辑（`guard/tool_output._truncate_body`，head/tail + `…N tokens truncated…` 标记）。

- **预算**：`ATTACHMENT_PREVIEW_TOKEN_LIMIT`（默认 15000，可配；`<=0` 关闭），并与窗口取小：`min(context_window // 2, 配置值)`，避免小窗口模型被预览淹没。窗口由 `get_model_context_config(model_id, model_config)` 解析。
- **快路径**：整块在预算内则原样返回，保持 prefix 缓存稳定。

### 多附件分配（water-filling）

所有附件共享一份预算（避免附件多时 N×预算爆）。预算先扣掉“块首集中 ID 列表 + 所有头部”，剩余在各段之间按 **water-filling** 分配：

- 小于公平份额的段整段保留，把余量退还池子，公平份额对剩余段重算；
- 大段吸收富余 —— 避免“小附件浪费配额、大附件被多砍”。

例：A=30k、B=5k tokens，预算 30k → B 整段保留(5k)，A 截到约 25k。每段各自 head/tail，**每个头（含 ID）都保留**；多附件时块首再加一行集中 ID 索引。

### 类型化提示

被截断的段后追加一行“如何取完整内容”的提示，按 header 里的 `Type:` 判定：

- **文本类**：`[Preview truncated. Full file in the sandbox at <path> — read or grep/search it with your file tools to get the rest.]` —— 沙箱原文完整，鼓励 grep/search 定向取而非整篇读；
- **二进制类（pdf/office/xmind）**：`[Preview truncated. Get the rest via read_attachment(attachment_id=N) for the parsed text, or open the sandbox file (path in the header above) with a suitable tool.]` —— 不把模型限定在单一手段。

文本/二进制的判定用统一的 MIME 归类 `shared/utils/mime_types.py::is_text_readable_mime`，与 backend parser 保持一致（新增类型只改一处）。

## `read_attachment` 工具

补充预览：让模型分页读取附件的完整提取文本（主要面向二进制附件；文本附件可直接读沙箱原文）。

- **条件注册**：仅当对话含**文档**附件时才注册进 function-calling schema（`services/context.py`）。`read_attachment` 只服务有提取文本的文档；图片/视频没有文本（调用只会返回 empty），故纯图片/视频对话**不注册**。判定：当前轮用结构化的 `request.attachments[].mime_type`（非 `image/`、非 `video/` 即文档，格式无关、稳定），历史轮 fallback 扫 `[Attachment:` 头。普通对话不注册，不走 lazy provider（那是技能系统专用）。
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

## 可观测性

附件预览的 traces 与 tool output、summary compact 共用统一的 `context_protection.{operation}` 结构,集中说明(各 operation 的 status / 属性 schema)见 [Chat Shell 上下文治理 · 可观测性](./chat-shell-context-governance.md#可观测性)。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `ATTACHMENT_INJECT_MAX_CHARS` | 32000 | backend 注入层字符上限（所有模式）；超出做 head/tail 截断 |
| `ATTACHMENT_PREVIEW_TOKEN_LIMIT` | 15000 | chat shell 附件预览共享预算（与 `context_window // 2` 取小）；`<=0` 关闭预览 |
| `MAX_EXTRACTED_TEXT_LENGTH` | 500000 | 解析期存储上限（供 read_attachment / 真文件下载，非注入量） |

## 非目标（后续档位）

- 表格 DuckDB 查询（就地查 xlsx/csv，只回结果行）；
- 散文 RAG（task 级临时索引，不暴露为用户知识库）；
- 大纲/标题寻址读；
- 视频/音频等无文本提取的类型（当前无能力）。
