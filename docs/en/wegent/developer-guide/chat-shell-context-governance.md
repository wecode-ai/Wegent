---
sidebar_position: 31
---

# Chat Shell Context Governance

## Overview

`chat_shell` context governance landed in three stages:

1. **Stage 1: tool-output governance**
   Bound oversized tool output into a stable model-visible compact form, and add
   context metrics plus frontend status visibility.
2. **Stage 2: summary compact**
   When the full live state approaches the window limit, run request-level
   summary compaction inside the same guard framework, with a conservative
   fallback path.
3. **Stage 3: attachment context governance**
   Replace "full attachment text injected every turn" with bounded previews plus
   on-demand reads.

The shared objective is not "build a compressor". It is to establish one
**unified, extensible, observable** control path before every model call.

## What Was Missing Before

Before the three-stage rollout, `chat_shell` already had a few local control
points, but it still had three clear gaps:

- **no single pre-request control point**
  Some controls lived in `build_messages`, some depended on tool events or later
  processing, and pre-turn / mid-turn budgeting did not naturally share one
  path.
- **no layered treatment for different context sources**
  Tool output, restored history, and attachment injection could all inflate the
  live state, but there was no unified framework to shrink risky sources first
  and then judge the whole request.
- **no stable runtime observability surface**
  When a conversation felt "stuck" or suddenly became too large, it was hard to
  answer which source was growing, whether compaction had fired, and whether the
  post-compaction state had actually returned to a safe range.

In practice, the old path had a few recurring problems:

- large tool output could re-enter follow-up model calls, with only partial
  guarding and easy drift between code paths
- history compaction was biased toward turn-start handling, while repeated
  mid-turn tool calls could still push the live state upward
- extracted attachment text was injected inline as a persistent `<attachment>`
  block, so it kept consuming context even when summary compact did not trigger
- once attachment-heavy or history-heavy turns did trigger summary compact, the
  current user question could get folded together with the rest of the message
- the frontend had no stable remaining-context status surface, especially after
  reload or reconnect

That is why the goal of this work was not "improve one truncation path". The
goal was to turn pre-model-call context governance into a single mechanism.

## Design approach

### One control point instead of scattered patches

The key control point is the `LangGraph pre_model_hook`, because it naturally
covers both:

- **pre-turn** model calls at the start of a turn
- **mid-turn** model calls after tools finish

This is more reliable than spreading budget logic across `build_messages`, tool
events, history serialization, and other side paths. In the final shape,
budgeting converges on `UnifiedContextGuard`.

### Separate UI-visible raw data from model-visible compact data

This is one of the most important boundaries in the design.

- **Raw / UI-visible representation** is for rendering, replay, and protocol
  compatibility.
- **Model-visible representation** is for the next provider call.

Examples:

- raw tool output still lives in block / result data
- `messages_chain` stores the compact model-facing form
- full attachment content still exists in sandbox files or extracted-text
  storage, while the prompt only carries a preview

The point is not to hide data. The point is to avoid forcing one field to serve
both "good for display" and "good for the model".

### Layered governance instead of one generic compression step

Context governance now has three layers:

1. **source-level guards**
   Shrink risky payloads such as tool output and attachment previews first.
2. **request-level compaction**
   Recompute the full live-state budget and compact when needed.
3. **emergency fallback**
   If still over budget, apply stricter deterministic re-truncation or failover.

This clearly borrows from systems like Codex, but it does not copy their
history-rewrite model.

## Borrowed ideas and deliberate trade-offs

The implementation borrows a few ideas that work well in practice:

- run the main budget decision **right before** provider invocation
- bound **high-risk context sources** before evaluating the whole request
- provide **on-demand retrieval paths** instead of forcing the model to keep
  consuming long payloads inline

But Wegent keeps its own trade-offs:

- **No persisted Codex-style `replacement_history`**
  Compaction rewrites only the current live state.
- **Summary compact is not a long-term memory layer**
  It is a request-time governance tool.
- **Fallback is not the main feature path**
  Tool-output guard, summary compact, and attachment preview are all first-class
  main-path behaviors.

## What each stage solved

## Stage 1: tool-output governance and status visibility

Stage 1 focused on the easiest source to let explode first: tool output.

Main outcomes:

- introduce the `UnifiedContextGuard` framework and wire it into
  `pre_model_hook`
- add `ToolOutputGuardAdapter` with a stable compact representation
- remove old serialization-time tool truncation
- emit `context_metrics` snapshots and surface them in the toolbar
- support reload / reconnect recovery for the latest context status

This stage established the **governance skeleton and observability surface**.

## Stage 2: summary compact and budget closure

Stage 2 completed request-level governance. When source-level shrinking is not
enough, the full live state goes through summary compaction.

Main outcomes:

- summary compact becomes the Stage 2 main path inside `UnifiedContextGuard`
- pre-turn and mid-turn share the same budget decision path
- available input budget is derived from a flat reserved-output buffer rather
  than directly using the model's maximum output ceiling
- compaction results are persisted in `subtask.result.context_compactions`
- add stable `[SummaryCompact]` logs and completion-state recovery

The key win is not "summarization". It is **closing the full-request budget
loop**.

## Stage 3: attachment preview and on-demand read

Stage 3 addressed another long-standing source of pressure: large attachments
were injected inline and stayed in the context every turn.

Main outcomes:

- switch from full inline attachment text to bounded previews
- size previews with token budgets on the chat-shell side, not plain character
  caps alone
- expose full content through sandbox files or the `read_attachment` tool
- use different full-content hints for text vs binary attachments
- align attachment preview, tool-output guard, and summary compact with the same
  protection-trace shape

This turns attachments from an implicit history burden into an explicit,
governed context source.

## Implementation map

These modules are the best entry points for future maintenance:

| Module | Role |
|---|---|
| `chat_shell/guard/context_guard.py` | Unified governance entry point: source pass, summary compact, emergency pass |
| `chat_shell/guard/tool_output.py` | Compact tool-output rendering and emergency re-truncation |
| `chat_shell/compression/summary_compactor.py` | Summary compact core logic |
| `chat_shell/compression/config.py` | Context window, reserved output, trigger / target limit calculation |
| `chat_shell/compression/context_metrics.py` | Context metrics snapshots |
| `chat_shell/messages/attachment_preview.py` | Attachment preview budgeting and truncation |
| `chat_shell/tools/builtin/read_attachment.py` | On-demand attachment reads |
| `chat_shell/services/chat_service.py` | Guard, tracker, and summary-LLM assembly |

For Stage 3 specifics, continue with
[Chat Shell Attachment Context](./chat-shell-attachment-context.md).

## Observability

The most stable observability surfaces today are:

- `context_metrics`
  for current window, used tokens, remaining percentage, and trigger state
- `[SummaryCompact]` logs
  for trigger / fallback behavior and before-after token deltas
- `subtask.result.context_compactions`
  for offline reporting of compaction counts, success rates, and token savings
- `context_protection.{operation}` traces
  for uniform timing and savings metrics across `tool_output`,
  `summary_compact`, and `attachment_preview`

All three protections emit via `chat_shell/guard/traces.py::record_protection_trace`
under the event name `context_protection.{operation}` with a consistent schema, so
the backend can derive **event count / success rate (by status) / duration
(duration_ms) / tokens saved**:

| operation | Trigger | status | Key attributes |
|---|---|---|---|
| `attachment_preview` | message with an attachment block | `applied` / `noop` | duration_ms, before/after_tokens, tokens_saved, attachment_blocks_truncated |
| `tool_output` | tool-output truncation (only when it happens) | `applied` | duration_ms, messages_truncated, emergency |
| `summary_compact` | request-level summary compaction | `completed` / `fallback` | duration_ms, before/after_tokens, tokens_saved, removed_history_items / failure_reason |

No event is emitted on a no-op (`tool_output` only when it truncates,
`attachment_preview` only when an attachment block is present); `add_span_event`
is a no-op when telemetry is disabled.

This is why Stage 1 added status and metrics before Stage 2 and Stage 3:
without observability, governance is hard to tune safely.

## Notes

### Summary compact only rewrites live state

The compacted replacement history is not persisted as the new canonical session
history. Later turns rebuild from the full stored history and re-evaluate
compaction when needed. This is an intentional simplification.

### `max_output_tokens` is budget input, not a history-rewrite result

Context governance uses `context_window` and `max_output_tokens` during
reserved-output budgeting, but live-history rewriting does not mutate provider
request parameters. If provider parameters look wrong, inspect the incoming
`model_config` chain first.

### Attachment preview is tokenized only inside chat shell

backend / shared modules do not carry `tiktoken`. As a result:

- shared is a good place for pure string helpers and MIME classification
- token preview must stay in chat shell
- executor / device paths see injected strings but do not have the
  chat-shell-only `read_attachment` tool

### Do not mix raw transcript and model-visible transcript

When changing export, replay, or protocol paths, first confirm whether the code
is reading:

- the user-visible raw output
- or the compact form seen by the model in the next turn

Many "why is this shorter here but still full there?" issues reduce to mixing
those two views.

## Related documents

- [Chat Shell Attachment Context](./chat-shell-attachment-context.md)
- [Dynamic Context](./dynamic-context.md)
