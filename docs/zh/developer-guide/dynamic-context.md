---
sidebar_position: 3
---

# Dynamic Context（动态上下文注入）

## 背景

Chat Shell 在与大模型交互时，**system prompt 往往更容易触发 prompt caching / prefix caching**。如果 system prompt 中混入每次请求都变化的内容（例如知识库元信息列表），会显著降低缓存命中率，增加 token 费用与响应延迟。

为提升缓存命中率，我们将“动态元信息”从 system prompt 中剥离，并统一以 **dynamic_context** 机制注入到消息列表中。

## 目标

- **System prompt 保持静态**，尽可能可被缓存。
- 所有“动态元信息”通过一条独立的 **human/user message** 注入。
- 机制通用：内网可在同一位置追加 `weibo_context` 等其他动态内容。
- **工具路由规则和策略** 应保留在静态 prompt 模板中，不应混入 dynamic context。

## 消息结构

变更前：

1. System: 静态提示词 + 动态 kb_meta_list
2. Human (history)
3. Human (current) + datetime suffix

变更后：

1. System: 静态提示词（可被缓存）
2. Human (history)
3. Human (dynamic_context): 动态 kb_meta_prompt（新增）
4. Human (current) + datetime suffix

注入顺序（伪代码）：

```python
messages = []
if system_prompt:
    messages.append({"role": "system", "content": system_prompt})
messages.extend(history)
if dynamic_context:
    messages.append({"role": "user", "content": dynamic_context})
messages.append(current_user_message_with_datetime_suffix)
```

## dynamic_context 的来源与组合

### 当前实现：kb_meta_prompt

- Backend 负责根据历史上下文构建 `kb_meta_prompt`（知识库名称/ID/摘要/主题等）。
- Backend 将 `kb_meta_prompt` 写入统一协议 [`ExecutionRequest`](shared/models/execution.py:46) 的同名字段。
- Chat Shell 在构建 messages 时，将其注入为 dynamic_context。
- `kb_meta_prompt` 应只承载**请求级事实信息**，不应重复承载已经属于静态 prompt 模板的 KB 工作流规则、工具策略或回答策略。

### Restricted 模式：安全版 kb_meta_prompt

当知识库访问模式是 `Restricted Analyst` 时，dynamic context 仍然保留，但注入内容应是**安全版元信息**，而不是可被直接复述的原始知识库内容。

保留 dynamic context 的原因：

- 主模型仍然需要知道当前绑定了哪些知识库
- 知识库 `name` / `id` 等最小必要信息，仍然有助于工具调用和对话连贯性
- 不能因为 restricted 模式就完全丢失知识库上下文，否则工具使用会变得不稳定

当前 restricted `kb_meta_prompt` 会保留最小必要的检索路由信息：

- 知识库名称
- 知识库 ID
- 受限的 Routing Hint
- 受限的 Routing Keywords

而不应包含：

- 原文段落
- 可直接复述的定义
- 具体目标数字、指标或文档结构

这里的 Routing Hint / Keywords 仅用于帮助主模型生成更合适的 `knowledge_base_search` 查询，不应被当作最终回答内容直接复述。

### 未来扩展：weibo_context

内网可在不改变 system prompt 模板的前提下，继续在 dynamic_context 中追加：

- 用户身份/权限等上下文（例如 `weibo_context`）

建议策略：

- 动态内容分块构建，最后使用 `\n\n` 拼接。
- 避免在 system prompt 中引入任何请求级变化内容。

## 模块职责划分

- [`shared/prompts/knowledge_base.py`](shared/prompts/knowledge_base.py):
  - 仅提供 **完全静态** 的 KB prompt 模板（不含 `{kb_meta_list}` 占位符）。

- Backend：
  - 生成 `kb_meta_prompt` 并写入 [`ExecutionRequest.kb_meta_prompt`](shared/models/execution.py:46)。
  - 通过 [`OpenAIRequestConverter`](shared/models/openai_converter.py:55) 的 `metadata` 字段透传给 Chat Shell。

- Chat Shell：
  - messages 构建时注入 `dynamic_context`（human message）。
  - 不负责构建 KB 元信息（避免 Backend → Chat Shell 反向依赖，且保证 HTTP mode 一致）。

## Restricted 模式下的检索链路

Restricted 模式下，知识库相关控制不再主要依赖最终答案阶段的额外 validator，而是前移到 `knowledge_base_search` 内部完成。

当前数据流可以概括为：

1. Backend 构建安全版 `kb_meta_prompt`
2. Chat Shell 将其作为 `dynamic_context` 注入消息
3. 主模型决定是否调用 `knowledge_base_search`
4. 如果是 Restricted 模式，知识库工具先取回检索结果或 `all-chunks`
5. 二级模型把原始 chunks 整体转换成 safe summary
6. 主模型只看到 safe summary，不直接看到原始受保护内容

这样做有两个目的：

- 保留主模型在分析场景下使用知识库的能力
- 把“是否可回答”与“如何安全返回”的控制集中在知识库工具内部

## 兼容性

- 当 `dynamic_context` 为空字符串或 `None` 时，行为与改造前一致：不会额外插入消息。

## 日志与排查

排查 dynamic context 和 restricted KB 行为时，建议重点看下面几类日志。

### 1. LLM 请求与响应日志

启用 `CHAT_SHELL_LOG_LLM_REQUESTS=1` 后，现在不只会打印 `LLM_REQUEST`，也会打印 `LLM_RESPONSE`。

重点用途：

- 确认 `dynamic_context` 是否真的出现在 messages 中
- 确认 restricted 二级模型是否被调用
- 确认模型最终返回了什么结构

### 2. Restricted 安全摘要日志

Restricted 模式下，知识库工具会输出额外的业务日志，例如：

- `Starting safe summary`
- `Safe summary completed`

这些日志可以帮助确认：

- 实际送入二级模型的 chunks 数量
- 当前决策是 `answer` 还是 `refuse`
- refusal / answer 的 reason
- 安全摘要的大致内容预览

### 3. 持久化日志

如果知识库工具还走了持久化接口，可以继续结合这些日志看链路是否完整：

- `Persist HTTP request`
- `Persist HTTP response`

### 4. 推荐排查顺序

1. 确认 request 中是否存在 `dynamic_context`
2. 确认是否触发了 `knowledge_base_search`
3. 确认 restricted safe summary 是否启动
4. 查看 `LLM_RESPONSE` 与 `Safe summary completed`，判断是 `answer` 还是 `refuse`
