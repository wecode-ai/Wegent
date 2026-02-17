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

## 兼容性

- 当 `dynamic_context` 为空字符串或 `None` 时，行为与改造前一致：不会额外插入消息。

## 排查建议

- 在 Chat Shell 启用 `CHAT_SHELL_LOG_LLM_REQUESTS=1`，查看 [`LangGraphAgentBuilder`](chat_shell/chat_shell/agents/graph_builder.py:239) 记录的 request payload：
  - 确认 messages 序列中 `history` 之后、当前 user 之前存在一条 `role=user` 的 dynamic_context。
