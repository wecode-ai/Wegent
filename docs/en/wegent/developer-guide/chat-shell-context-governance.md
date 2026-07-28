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

**Coverage boundary (important — do not be misled by "non-streaming").**
`UnifiedContextGuard` is attached via `pre_model_hook` only when the **chat
execution engine** builds its agent, so distinguish two kinds of "non-streaming":

- **Transport-level non-streaming** (HTTP `stream=false` follow-ups): only buffers
  the SSE events and returns once — the **execution engine is still
  `stream_tokens`**, so the guard, compaction recovery, and persistence all apply.
  It **is** governed.
- **Engine-level non-streaming** (`agent.execute` → `_collect_final_state_from_events`):
  whether the guard attaches depends on whether the caller passes a
  `pre_model_hook`. The only current user is the answer-audit `correction_service`,
  which does **not** pass one — a **guard-bypassing short path**: no compaction
  governance, the history under review is embedded into the prompt, the result is
  written only to `subtask.result.correction` (**no `messages_chain`**), with its
  own try/except fallback. It is a one-shot auditor, not a conversation/follow-up
  path, and is decoupled from this context governance.

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

- **Checkpoint persisted in `messages_chain`, not a separate blob** (Phase 1)
  The compacted turn becomes a self-contained checkpoint (retained recent user
  messages + summary) inside its own `messages_chain`, and reload starts from the
  latest checkpoint. This is functionally close to Codex's `replacement_history`,
  but reuses existing persistence instead of a new field. Phase 2a then makes that
  persistence independent of how the turn terminates by reading the authoritative
  LangGraph state through a request-local checkpointer. See the Phase 1 and Phase
  2a sections.
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

## Phase 1: checkpoint reload and hang hardening

Phase 1 closes two gaps left by Stage 2.

### Checkpoint reload (no more full-history re-inflation)

Previously every new subtask reloaded the full raw transcript and re-ran a full
compaction — for multi-day sessions this meant compacting ~1.7M tokens on each
new turn. Phase 1 makes the compacted turn a **self-contained checkpoint**:

- `_select_recent_user_messages` clones the retained recent user messages with a
  fresh id and a `checkpoint_retained` marker so the turn serializer keeps them
  in `messages_chain` (alongside the `summary_compacted` summary and the in-turn
  suffix generated after it).
- The backend history endpoint accepts `from_latest_compaction=true`: it locates
  the latest checkpoint by the in-chain `summary_compacted` marker and returns
  `[checkpoint chain] + [subsequent complete turns]`. `limit` never truncates the
  checkpoint chain itself.
- The HTTP endpoint and the package-mode loader share one pipeline
  (`resolve_history_subtasks`) so fork, `before_message_id`, `limit`, and
  checkpoint scoping stay identical.
- Because the HTTP transport drops `additional_kwargs`, a reloaded summary is
  re-recognized by its content marker so it is not re-retained as a user message.

### Hang hardening

The summary compaction path was hardened against a production hang where an
O(n²) trim pegged CPU for minutes and the backend read-timeout then cancelled the
turn:

- the trim is a single O(n) budget pass over the sanitized prompt (no per-removal
  re-count, no per-message reply-priming inflation)
- a heartbeat ticker emits `summary_compact` in_progress status during compaction
  so the SSE stream stays alive instead of racing the backend read-timeout
- the summary LLM call has a provider timeout plus an `asyncio.wait_for` backstop
- context-length classification recognizes HTTP 413 and non-English markers; a
  bare 400 is not treated as overflow (avoids a retry storm)

## Phase 2a: authoritative-state persistence across terminal paths

Phase 1 made a compacted turn a self-contained checkpoint, but persistence still
depended on the happy path. The turn's `messages_chain` was serialized from
`_collected_state_messages`, captured from top-level `on_chain_end` events under a
"keep the longest snapshot" gate. Two consequences:

- On a `GraphRecursionError` (tool-call limit) the top-level end may never fire,
  and the recovery rebuilt the chain from the pre-run `lc_messages` — so a turn
  that both compacted **and** hit the tool limit persisted only the recovery
  reply and silently dropped the checkpoint. The next continuation then fell back
  to an older checkpoint.
- Compaction *shrinks* the live state, so the "longest snapshot" gate could reject
  the real post-compaction state.

Phase 2a makes the **last authoritative LangGraph state** the single source for a
single finalizer, on every terminal path.

### Request-local checkpointer read via `aget_state`

- Every agent build attaches a **request-local `InMemorySaver`**, and each turn
  (and each truncation-retry level) runs on a unique `thread_id` with
  **`durability="exit"`**. Exit durability commits exactly one checkpoint at graph
  exit — including on exception exit — so `aget_state(config)` returns the
  authoritative post-compaction state (summary + completed post-compaction tool
  pairs) at ~1× memory instead of one snapshot per super-step. The dormant
  `ENABLE_CHECKPOINTING` toggle was removed; the checkpointer is not optional.
- `_finalize_turn_history` is the single atomic choke point: it sanitizes tool
  pairs, filters to this turn's new messages by a turn-invariant
  `original_input_ids` (see `TurnExecutionContext`), serializes/validates, and
  sets `_last_messages_chain`, `_last_live_state_messages`, and
  `_last_termination_reason` together so they cannot drift.
- Every **streaming** terminal path funnels through it: normal completion,
  `completed_with_unexecuted_tool_calls`, tool-limit recovery, truncation retry
  and retry-exhausted, and silent/deferred exit. The old
  `_collected_state_messages` / length-gate authority is gone.
- **Finalizer execution ≠ durable persistence.** The finalizer only sets the
  in-memory `_last_messages_chain` on the builder; whether that becomes durable in
  `subtask.result.messages_chain` depends on the terminal status. Supported
  (COMPLETED-style) terminals persist it; carrying and persisting it for `FAILED`
  / `CANCELLED` is deferred to Phase 2b (see "Not in Phase 2a" below). So the
  finalizer may run on a path whose chain is not ultimately stored.
- The **engine-level non-streaming** path (`agent.execute` →
  `_collect_final_state_from_events`) does **not** build a `messages_chain`: it
  returns the LangGraph final state (its callers consume only content/tool-results,
  and `messages_chain` is persisted on the streaming path alone). It still shares
  the request-local checkpointer, exit durability, recovery-from-current-state, and
  per-turn thread teardown; it just has no finalizer because it produces no
  persisted history. **Note:** HTTP `stream=false` follow-ups are **not** this
  case — they still run on `stream_tokens` and go through the finalizer and
  persistence (see the coverage boundary under "single control point").

### Recovery and retry read the current state, not `lc_messages`

- **Tool-limit recovery** feeds the recovery LLM the current authoritative state
  (sanitized), so it sees the tool results it already produced; the final state is
  `safe_state + [recovery reply]`, and the internal tool-limit instruction is
  excluded from what persists.
- **Truncation retry** seeds a **fresh thread** with the sanitized authoritative
  state (re-submitting to the same thread would not delete the truncated tool call
  — `add_messages` merges by id) and **inherits the root `original_input_ids`**.
  The truncation instruction rides a separate **attempt control plane**: it lives
  only in `_attempt_guidance` and is injected into the model input via
  `llm_input_messages` by the builder's own `_attempt_guidance_hook` (the last link
  in the pre-model chain), **after** compaction. It never enters the `messages`
  channel, so it stays out of the summary source, the checkpoint, and the persisted
  `messages_chain`, and never competes with the real user turn for the recent-user
  budget. Because it is appended after compaction, the retry thread's own
  compaction cannot trim it away, and it is naturally discarded when the retry
  attempt ends. `chain_pre_model_hooks` rolls `llm_input_messages` forward through
  each hook so user guidance and attempt guidance stack instead of clobbering each
  other.

### Lifecycle and observability

- Each `stream_tokens` level deletes **its own** thread in a `finally`
  (`adelete_thread`); failures are logged, not silently suppressed, and
  `checkpoints_in_saver` is measured before the delete. A per-turn persistence log
  records `path`, `chain_msgs`, `has_summary_marker`,
  `post_compaction_tool_pairs`, `checkpoints_in_saver`, and `adelete_thread_ok`.
- The checkpointer is a per-request scratchpad for reading authoritative state
  within one turn; the durable store remains `subtask.result.messages_chain`. No
  separate checkpoint blob is introduced, and reconstruction is unchanged — the
  finalizer reuses the same serializer, so recovery-path checkpoints reload
  identically to normal-completion ones.

Not in Phase 2a (deferred): letting non-`COMPLETED` terminals (FAILED / CANCELLED)
carry and persist `messages_chain`, and relaxing the checkpoint locator to
recognize them.

## Phase 2b (evaluated and deferred)

Phase 2b would have let FAILED / CANCELLED terminals also carry and persist
`messages_chain`. After evaluation it was **deliberately deferred**:

- **It is a token-saving optimization, not a data-loss fix.** On failure the partial
  reply the user already saw is rebuilt into `result.value` by
  `collect_completed_result(status="FAILED")` from the streamed blocks, so reload
  still shows it; only the failed turn's structured `messages_chain` is missing. And
  compaction only rewrites the runtime window — **it never rewrites earlier subtasks'
  records** — so continuation reloads the full original history and re-compacts once.
  The cost is one redundant compaction's tokens, not user-visible lost content.
- **Narrow trigger.** It requires (compaction within a turn) ∩ (that turn ending
  FAILED) — a small intersection.
- **Cost/risk out of proportion.** Wiring the failure chain through means changing the
  SSE `error` terminal contract (the `error` event terminates the SSE read loop before
  `response.completed`, and `_status_updated` blocks any later update), with a blast
  radius across the SSE / WebSocket / HTTP-callback transports.

**Cheaper direction if revisited:** rather than forcing the chain through the error
terminal, persist the summary as its own durable record **at compaction time** (not at
turn end), so it survives any terminal state for free. Restart when telemetry shows
material re-compaction churn from failures, or when the compaction persistence structure
is being changed anyway.

## Implementation map

These modules are the best entry points for future maintenance:

| Module | Role |
|---|---|
| `chat_shell/guard/context_guard.py` | Unified governance entry point: source pass, summary compact, emergency pass |
| `chat_shell/guard/tool_output.py` | Compact tool-output rendering and emergency re-truncation |
| `chat_shell/compression/summary_compactor.py` | Summary compact core logic, O(n) trim, checkpoint-retain markers |
| `chat_shell/compression/tool_sanitizer.py` | Shared `sanitize_tool_pairs` used by compaction, recovery, and the finalizer (Phase 2a) |
| `chat_shell/guard/composition.py` | `chain_pre_model_hooks`: composes pre-model hooks, rolling `llm_input_messages` forward so producers stack |
| `chat_shell/agents/graph_builder.py` | Request-local exit-durability checkpointer, `_finalize_turn_history`, attempt control plane (`_attempt_guidance_hook`), per-path terminal handling (Phase 2a) |
| `chat_shell/agents/turn_context.py` | `TurnExecutionContext`: turn-invariant `original_input_ids` + per-level thread ownership (Phase 2a) |
| `chat_shell/history/loader.py` | History reload; forwards `from_latest_compaction` |
| `backend/app/services/chat/compaction_checkpoint.py` | Locate latest checkpoint + shared resolve→scope→limit pipeline (Phase 1) |
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

### Reload starts from the latest compaction checkpoint (Phase 1)

Earlier, later turns rebuilt from the full stored history and re-evaluated
compaction every time, which re-inflated long sessions. Phase 1 persists a
self-contained checkpoint in the compacted turn's `messages_chain` (retained
recent user messages tagged `checkpoint_retained` plus the summary tagged
`summary_compacted`) and reloads from the latest checkpoint via the backend
`from_latest_compaction` path. See the Phase 1 section below.

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
