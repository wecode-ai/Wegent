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

## Injection cap (backend, character-level, all modes)

The extracted text is first capped on the backend injection layer
(`context_service.build_document_text_prefix`) to `ATTACHMENT_INJECT_MAX_CHARS`
**characters** (default 32000) before it enters any mode's prompt. This separates
**storage** from **injection**:

- **Storage**: the full extracted text (≤ `MAX_EXTRACTED_TEXT_LENGTH`, default
  500k chars) stays in the DB for `read_attachment` paging and for the
  executor/device to download the real file;
- **Injection**: what enters the prompt is a bounded preview (contiguous head +
  tail + a single marker pointing to the full file in the header).

This layer applies to **all modes** and is the only injection-length guard for
executor / device (which have no chat-shell token preview). chat shell adds a
token-level preview on top (below).

## Inline preview (token-bounded, chat shell)

After `agent.build_messages` assembles the messages (and before cache
breakpoints), every `<attachment>` block is token-bounded (current turn and
replayed history handled identically; refining on top of the backend character
cap above). See `chat_shell/messages/attachment_preview.py`, which reuses the
tool-output truncation logic (`guard/tool_output._truncate_body`, head/tail +
`…N tokens truncated…` marker).

- **Budget**: `ATTACHMENT_PREVIEW_TOKEN_LIMIT` (default 15000, configurable;
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

- **Text**: `[Preview truncated. Full file in the sandbox at <path> — read or grep/search it with your file tools to get the rest.]`
  — the sandbox original is complete; encourages targeted grep/search instead of
  reading the whole file;
- **Binary (pdf/office/xmind)**: `[Preview truncated. Get the rest via read_attachment(attachment_id=N) for the parsed text, or open the sandbox file (path in the header above) with a suitable tool.]`
  — not locking the model into a single action.

The text/binary split uses the shared MIME classification
`shared/utils/mime_types.py::is_text_readable_mime`, consistent with the backend
parser (new types are added in one place).

## The `read_attachment` tool

Complements the preview: lets the model page through an attachment's full
extracted text (mainly for binary attachments; text attachments can be read
directly from the sandbox).

- **Conditional registration**: added to the function-calling schema only when
  the conversation has a **document** attachment (`services/context.py`).
  `read_attachment` serves extracted text, which only documents have; images and
  videos have none (a call would just return "empty"), so image/video-only
  conversations don't register it. Detection: the structured
  `request.attachments[].mime_type` for the current turn (a document is anything
  not `image/*` or `video/*` — format-independent and stable), falling back to a
  `[Attachment:` header scan for history. Plain chats don't register it; it does
  not use the lazy provider (that is skill-system specific).
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

## Observability

Attachment-preview traces share the unified `context_protection.{operation}`
structure with tool output and summary compact; see the consolidated reference
(per-operation status / attribute schema) in
[Chat Shell Context Governance · Observability](./chat-shell-context-governance.md#observability).

## Configuration

| Setting | Default | Description |
|---|---|---|
| `ATTACHMENT_INJECT_MAX_CHARS` | 32000 | Backend injection char cap (all modes); head/tail truncation beyond it |
| `ATTACHMENT_PREVIEW_TOKEN_LIMIT` | 15000 | chat shell attachment preview budget (min'd with `context_window // 2`); `<=0` disables |
| `MAX_EXTRACTED_TEXT_LENGTH` | 500000 | Parse-time storage cap (for read_attachment / real-file download, not the injected amount) |

## Non-goals (future tiers)

- DuckDB query over tables (query xlsx/csv in place, return only result rows);
- RAG over prose (task-level ephemeral index, not exposed as a user knowledge base);
- outline / heading-addressed reads;
- video/audio and other non-text-extractable types (no capability today).
