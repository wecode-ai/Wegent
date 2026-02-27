---
sidebar_position: 3
---

# Dynamic Context (Injecting Request-Scoped Context)

## Background

In Chat Shell, the **system prompt** is the most cache-friendly part for LLM prompt caching / prefix caching. If we mix request-scoped, frequently changing content into the system prompt (e.g., knowledge base metadata lists), the cache hit rate drops significantly, increasing token cost and latency.

To improve cache hit rate, we split “dynamic metadata” out of the system prompt and inject it into the message list via a unified **dynamic_context** mechanism.

## Goals

- Keep the **system prompt fully static** whenever possible so it can be cached.
- Inject all request-scoped metadata as a separate **human/user message**.
- Make the mechanism extensible: internal deployments can append `weibo_context` or other dynamic blocks in the same place.

## Message Structure

Before:

1. System: static instructions + dynamic kb_meta_list
2. Human (history)
3. Human (current) + datetime suffix

After:

1. System: static instructions (cacheable)
2. Human (history)
3. Human (dynamic_context): dynamic kb_meta_prompt (new)
4. Human (current) + datetime suffix

Injection order (pseudo-code):

```python
messages = []
if system_prompt:
    messages.append({"role": "system", "content": system_prompt})
messages.extend(history)
if dynamic_context:
    messages.append({"role": "user", "content": dynamic_context})
messages.append(current_user_message_with_datetime_suffix)
```

## Sources and Aggregation

### Current: kb_meta_prompt

- Backend builds `kb_meta_prompt` from historical contexts (KB name/ID/summary/topics, etc.).
- Backend writes it into the unified protocol [`ExecutionRequest`](shared/models/execution.py:46) as `kb_meta_prompt`.
- Chat Shell injects it into messages as `dynamic_context`.

### Future: weibo_context

Internal deployments can extend the same injection point to include:

- user identity / permission context (e.g. `weibo_context`)

Suggested approach:

- Build dynamic blocks independently, then join with `\n\n`.
- Avoid putting any request-scoped data into system prompt templates.

## Responsibilities

- [`shared/prompts/knowledge_base.py`](shared/prompts/knowledge_base.py):
  - Provides **fully static** KB prompt templates (no `{kb_meta_list}` placeholder).

- Backend:
  - Generates `kb_meta_prompt` and stores it in [`ExecutionRequest.kb_meta_prompt`](shared/models/execution.py:46).
  - Transports it to Chat Shell via [`OpenAIRequestConverter`](shared/models/openai_converter.py:55) `metadata`.

- Chat Shell:
  - Injects `dynamic_context` as a human message.
  - Must not build KB meta prompt locally (avoids reverse dependency and keeps HTTP mode consistent).

## Compatibility

If `dynamic_context` is an empty string or `None`, behavior is identical to pre-change behavior: no extra message is inserted.

## Debugging

Enable `CHAT_SHELL_LOG_LLM_REQUESTS=1` and inspect the request payload logged by [`LangGraphAgentBuilder`](chat_shell/chat_shell/agents/graph_builder.py:239):

- Confirm there is an extra `role=user` message inserted **after history** and **before the current user message**.
