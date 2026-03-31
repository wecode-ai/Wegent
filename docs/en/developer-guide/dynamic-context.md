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
- Keep **tool-routing rules and policy** inside static prompt templates rather than dynamic context.

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
- `kb_meta_prompt` should carry **request-scoped facts only**. It should not duplicate KB workflow rules, tool policy, or response policy that already belongs in static prompt templates.

### Restricted mode: safe kb_meta_prompt

When KB access runs under `Restricted Analyst`, dynamic context is still preserved, but the injected metadata should be a **safe metadata block** rather than directly reusable KB content.

Why dynamic context still exists in restricted mode:

- the main model still needs to know which KBs are currently bound
- minimal information such as KB `name` / `id` still helps tool calls remain stable
- removing KB context entirely makes knowledge tool usage less reliable

The current restricted `kb_meta_prompt` keeps only the minimum routing context needed for search:

- KB name
- KB ID
- constrained routing hint
- constrained routing keywords

It should not include:

- raw source passages
- definitions that can be restated directly
- exact targets, KPI values, or document structure

These routing hints exist only to help the main model draft better
`knowledge_base_search` queries. They must not be surfaced as final answer
content.

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

## Restricted Retrieval Flow

In restricted mode, KB safety no longer depends mainly on a final-answer validator. The control point has been moved into `knowledge_base_search`.

The current flow is:

1. Backend builds a safe `kb_meta_prompt`
2. Chat Shell injects it as `dynamic_context`
3. The main model decides whether to call `knowledge_base_search`
4. In restricted mode, the KB tool retrieves search results or `all-chunks`
5. A secondary model converts the raw chunks into a safe summary
6. The main model only sees the safe summary, not the protected raw content

This keeps two important properties:

- the main model can still use KB content for diagnosis and recommendations
- the answerability and redaction decision stays inside the KB tool

## Compatibility

If `dynamic_context` is an empty string or `None`, behavior is identical to pre-change behavior: no extra message is inserted.

## Debugging And Logs

When debugging dynamic context or restricted KB behavior, focus on the logs below.

### 1. LLM request and response logs

With `CHAT_SHELL_LOG_LLM_REQUESTS=1`, the system now logs both `LLM_REQUEST` and `LLM_RESPONSE`.

These logs help you verify:

- whether `dynamic_context` is really present in the message list
- whether the restricted secondary model was invoked
- what the model actually returned

### 2. Restricted safe-summary logs

Restricted KB flow now adds business-level logs such as:

- `Starting safe summary`
- `Safe summary completed`

These are useful for checking:

- how many chunks were actually sent to the secondary model
- whether the decision was `answer` or `refuse`
- the machine-readable reason
- a short preview of the safe summary

### 3. Persistence logs

If the KB tool also persists its result, continue checking:

- `Persist HTTP request`
- `Persist HTTP response`

### 4. Suggested debugging order

1. Confirm `dynamic_context` is present in the request
2. Confirm `knowledge_base_search` was triggered
3. Confirm restricted safe summary started
4. Inspect `LLM_RESPONSE` and `Safe summary completed` to see whether the result was `answer` or `refuse`
