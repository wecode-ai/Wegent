---
sidebar_position: 32
---

# Chat Shell Attachment Context (Preview & On-Demand Read)

If you want the broader three-stage rollout, design trade-offs, and maintenance
boundaries first, start with
[Chat Shell Context Governance](./chat-shell-context-governance.md).

## Background

When a user uploads an attachment (PDF / Word / Excel / image / text, etc.), its
extracted text is injected inline as its own `<attachment>` text block in the
user message. Injecting the whole thing causes two problems:

- **Carried every turn**: the attachment text occupies many tokens on every turn
  even when context compaction is not triggered;
- **Lossy compaction**: once the threshold is hit, summary compact folds /
  truncates the *whole* user message (cutting the question too), irreversibly.

This feature bounds the inline copy to a token-limited **preview**; the full
content is fetched on demand from the **sandbox file** or via the
**`read_attachment` tool**.

> Note: attachment parsing is synchronous (done within the upload request;
> defaults to the `parser.py` Python libraries — MinerU is knowledge-base only and
> off by default), so an attachment is READY as soon as it enters the
> conversation — there is no "parsing not finished" race.

## Message structure

The assembled user message is a list of content blocks; the attachment is its
**own block** (not merged with the question, which helps prefix caching):

```text
user.content = [
  {type: text,      text: "<user question>"},
  {type: image_url, ...},                          # images, if any
  {type: text,      text: "<attachment>…</attachment>"},   # all attachments in one block
  {type: text,      text: "<knowledge_base>…</knowledge_base>"},
  {type: text,      text: "<system-reminder>…</system-reminder>"},
]
```

Multiple attachments of one message are **merged into a single `<attachment>`
block**, each with a `[Attachment: name | ID: n | Type: … | File Path(already in sandbox): …]`
header.

## Inline preview (token-bounded)

After `agent.build_messages` assembles the messages (and before cache
breakpoints), every `<attachment>` block is token-bounded (current turn and
replayed history handled identically). See
`chat_shell/messages/attachment_preview.py`, which reuses the tool-output
truncation logic (`guard/tool_output._truncate_body`, head/tail +
`…N tokens truncated…` marker).

- **Budget**: `ATTACHMENT_PREVIEW_TOKEN_LIMIT` (default 30000, configurable;
  `<=0` disables), capped relative to the window: `min(context_window // 2, configured)`,
  so a small-context model is not swamped. The window comes from
  `get_model_context_config(model_id, model_config)`.
- **Fast path**: a block already within budget is returned untouched, keeping the
  prefix cache stable.

### Multi-attachment allocation (water-filling)

All attachments share one budget (avoids N×budget blowups). The budget first
reserves the consolidated id list and every header, then distributes the
remainder across segments by **water-filling**:

- a segment that fits its fair share keeps its full size and returns the leftover
  to the pool; the fair share is recomputed for the remaining segments;
- big segments absorb the freed budget — small ones don't waste their share while
  large ones get over-truncated.

Example: A=30k, B=5k tokens, budget 30k → B kept whole (5k), A truncated to ~25k.
Each segment keeps a head and a tail, and **every header (with its ID) is
preserved**; with multiple attachments a consolidated id index line is prepended.

### Type-aware hint

A truncated segment gets a trailing pointer to the full content, decided by the
`Type:` in its header:

- **Text**: `[Preview truncated. Full file readable in sandbox: <path>]` — the
  sandbox original is complete and exceeds the parse-time cap;
- **Binary (pdf/office)**: `[Preview truncated. Use read_attachment(attachment_id=N) for the full text.]`
  — the sandbox file is binary, so the parsed text is fetched via the tool.

## The `read_attachment` tool

Complements the preview: lets the model page through an attachment's full
extracted text (mainly for binary attachments; text attachments can be read
directly from the sandbox).

- **Conditional registration**: added to the function-calling schema only when
  the conversation (history or current turn) contains an `<attachment>` block
  (`services/context.py`). Plain chats don't register it; it does not use the
  lazy provider (that is skill-system specific).
- **Pagination protocol**: **character offset + token clamp** — the cursor is a
  character position (tokenizer-independent, reproducible across turns/models);
  the returned page is clamped to the per-page token budget (default aligned with
  the 15k tool-output budget), so a page never exceeds budget nor gets
  re-truncated by the request-level guard; `next_offset = offset + chars returned`.
- **Content upper bound**: the parse-time cap (default 500k chars); beyond that
  the original file must be read from the sandbox.
- **Call limit**: a per-conversation cap prevents unbounded paging.

### Permissions: task-scoped (incl. group chat)

Readable set = `{ context | context.subtask_id ∈ the task's subtasks, or unlinked }`,
matching history visibility.

- In group chat, attachments uploaded by different users have different `user_id`
  but belong to the same task — all are **readable**;
- cross-task access is denied (403); not-found / non-READY returns 404.
- **Not user-scoped** (attachments are conversation-shared, unlike user-owned
  knowledge bases).

### Dual path (remote / package)

- **HTTP/remote mode** (production default; backend and chat shell deployed
  separately): via the backend internal endpoint
  `GET /api/internal/chat/attachments/{id}/text?session_id=task-X&offset=&limit=`,
  returning a character slice + `total_chars` / `has_more`; pagination/token clamp
  is done on the chat shell side.
- **Package mode**: reads the database directly, with the same task scoping.

See `chat_shell/history/attachment_text.py::fetch_attachment_text`,
`chat_shell/storage/remote.py::get_attachment_text`, and
`backend/app/api/endpoints/internal/chat_storage.py`.

## Shared attachment header (consistency)

The `<attachment>` header is built by
`shared/utils/attachment_block.py::build_attachment_header`, shared between the
backend first-send preprocessing (`context_service` / `contexts`) and the chat
shell history rebuild (`history/loader`), so the format does not drift between the
first turn and history replay.

## Observability (traces)

The three context protections emit a uniformly-shaped span event via
`chat_shell/guard/traces.py::record_protection_trace`, named
`context_protection.{operation}`, so the tracing backend can derive **event
count / success rate (by status) / duration (duration_ms) / tokens saved**:

| operation | Trigger | status | Key attributes |
|---|---|---|---|
| `attachment_preview` | message with an attachment block | `applied` / `noop` | duration_ms, before/after_tokens, tokens_saved, attachment_blocks_truncated |
| `tool_output` | tool-output truncation (only when it happens) | `applied` | duration_ms, messages_truncated, emergency |
| `summary_compact` | request-level summary compaction | `completed` / `fallback` | duration_ms, before/after_tokens, tokens_saved, removed_history_items / failure_reason |

To avoid noise, no event is emitted on a no-op (`tool_output` only when it
truncates, `attachment_preview` only when an attachment block is present);
`add_span_event` is a no-op when telemetry is disabled.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `ATTACHMENT_PREVIEW_TOKEN_LIMIT` | 30000 | Shared attachment preview budget (min'd with `context_window // 2`); `<=0` disables the preview |

## Non-goals (future tiers)

- DuckDB query over tables (query xlsx/csv in place, return only result rows);
- RAG over prose (task-level ephemeral index, not exposed as a user knowledge base);
- outline / heading-addressed reads;
- video/audio and other non-text-extractable types (no capability today).
