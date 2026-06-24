# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Token-bounded preview for inline ``<attachment>`` blocks.

Attachment extracted-text is injected inline in the user message as its own text
block (alongside the question / images / knowledge-base block). Carrying the
full text every turn is wasteful, and summary-compact would otherwise fold or
crudely truncate the whole user message. This pass bounds the inline copy to a
fixed token budget, leaving the full content reachable via the sandbox file
(text) or the ``read_attachment`` tool (binary).

Design (all attachments share one ``<attachment>`` block):

* **Shared budget** across all attachments in the block (avoids N×budget blowups
  with many attachments), configurable via ``ATTACHMENT_PREVIEW_TOKEN_LIMIT``.
* **Per-segment head/tail**: the shared body budget is split across attachment
  segments so every attachment keeps both a head and a tail, each truncated with
  the same logic as tool outputs (:func:`guard.tool_output._truncate_body`).
* **Every header preserved**: each ``[Attachment: … | ID: n | …]`` header is kept
  verbatim, so every ``read_attachment`` id stays discoverable. When more than
  one attachment is present, a consolidated id list is also prepended.
* **Fast path**: blocks already within budget are returned untouched (keeps the
  prefix cache stable for the common small-attachment case).

The pass is origin-agnostic: it runs after message assembly and treats the
current turn and replayed history identically.
"""

from __future__ import annotations

import re
import time
from typing import Any

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.guard.tool_output import _truncate_body
from chat_shell.guard.traces import record_protection_trace
from chat_shell.guard.types import TruncationPolicy

_ATTACHMENT_BLOCK = re.compile(r"<attachment>(.*?)</attachment>", re.DOTALL)

# Matches the shared attachment/image header start and captures its id. The
# header is a single line produced by shared.utils.attachment_block; the
# ``| ID: <n> |`` segment is distinctive enough to anchor on.
_SEGMENT_HEADER = re.compile(r"\[(?:Image )?Attachment: [^\n]*? \| ID: (\d+) \|")
_HEADER_TYPE = re.compile(r"\| Type: ([^|\]]+)")
_HEADER_PATH = re.compile(r"File Path[^:]*: ([^\]]+)")
# MIME substrings of binary office/pdf documents whose sandbox file cannot be
# read as text — these must be read via read_attachment (parsed extracted text).
_BINARY_MIME_HINTS = (
    "pdf",
    "msword",
    "officedocument",
    "ms-excel",
    "ms-powerpoint",
    "spreadsheet",
    "presentation",
)


def _full_content_hint(header: str, attachment_id: str) -> str:
    """Type-aware pointer to the full content when a segment is truncated.

    Text files: the complete original is readable in the sandbox (beyond the
    preview, and beyond read_attachment's parse cap). Binary docs: the sandbox
    file is not text, so the parsed text is fetched via read_attachment.
    """
    type_match = _HEADER_TYPE.search(header)
    mime = type_match.group(1).strip().lower() if type_match else ""
    is_binary = any(hint in mime for hint in _BINARY_MIME_HINTS)
    if not is_binary:
        path_match = _HEADER_PATH.search(header)
        if path_match:
            return (
                f"\n[Preview truncated. Full file readable in sandbox: "
                f"{path_match.group(1).strip()}]"
            )
    return (
        f"\n[Preview truncated. Use read_attachment(attachment_id={attachment_id}) "
        f"for the full text.]"
    )


def _split_header_body(segment: str) -> tuple[str, str]:
    """Split an attachment segment into its first (header) line and the rest."""
    newline = segment.find("\n")
    if newline == -1:
        return segment, ""
    return segment[:newline], segment[newline + 1 :]


def _preview_attachment_body(body: str, total_limit: int, counter: TokenCounter) -> str:
    """Bound a single ``<attachment>`` block body to *total_limit* tokens.

    Splits the body into per-attachment segments, preserves every header, and
    distributes the remaining budget across segment bodies (each head/tail
    truncated). Falls back to a whole-body head/tail when no headers are found.
    """
    if counter.count_text(body) <= total_limit:
        return body  # fast path: already within budget, keep verbatim

    matches = list(_SEGMENT_HEADER.finditer(body))
    if not matches:
        # No recognizable headers (legacy/malformed) — bound the whole body.
        rendered, _t, _tr, _f = _truncate_body(
            body, TruncationPolicy(kind="tokens", limit=total_limit), counter
        )
        return rendered

    preamble = body[: matches[0].start()]
    segments: list[str] = []
    ids: list[str] = []
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        segments.append(body[match.start() : end])
        ids.append(match.group(1))

    # Consolidate ids up front when multiple attachments share the block, so
    # every read_attachment id is discoverable even after heavy truncation.
    # Per-segment hints (below) carry the type-aware "how to get the rest".
    id_line = ""
    if len(ids) > 1:
        id_line = "[Attachment IDs in this message: " + ", ".join(ids) + "]\n"

    # Reserve budget for the id line and every header (always kept), then
    # distribute the remainder across segment bodies.
    reserved = counter.count_text(preamble) + counter.count_text(id_line)
    headers_and_bodies: list[tuple[str, str]] = [
        _split_header_body(seg) for seg in segments
    ]
    reserved += sum(counter.count_text(header) for header, _ in headers_and_bodies)
    body_budget = max(0, total_limit - reserved)

    body_sizes = [counter.count_text(seg_body) for _, seg_body in headers_and_bodies]
    allocations = _allocate_budget(body_sizes, body_budget)

    rebuilt: list[str] = []
    for (header, seg_body), alloc, attachment_id in zip(
        headers_and_bodies, allocations, ids
    ):
        if seg_body:
            rendered, _t, truncated, _f = _truncate_body(
                seg_body, TruncationPolicy(kind="tokens", limit=alloc), counter
            )
            hint = _full_content_hint(header, attachment_id) if truncated else ""
            rebuilt.append(f"{header}\n{rendered}{hint}")
        else:
            rebuilt.append(header)

    return preamble + id_line + "".join(rebuilt)


def _allocate_budget(sizes: list[int], budget: int) -> list[int]:
    """Water-fill *budget* across segment bodies of the given *sizes*.

    Segments that fit their fair share keep their full size and return the
    leftover to the pool; the fair share is recomputed for the remaining
    (larger) segments so big attachments absorb the freed budget instead of
    being over-truncated while small ones waste their allocation. Result sums to
    at most *budget* (each allocation floored at 1 so truncation stays valid).
    """
    allocations = [0] * len(sizes)
    remaining_budget = budget
    # Smallest first: a segment that fits its share frees budget for the rest.
    for rank, idx in enumerate(sorted(range(len(sizes)), key=lambda i: sizes[i])):
        share = remaining_budget // (len(sizes) - rank)
        take = max(1, min(sizes[idx], share))
        allocations[idx] = take
        remaining_budget = max(0, remaining_budget - take)
    return allocations


def _preview_text(text: str, total_limit: int, counter: TokenCounter) -> str:
    """Truncate the body of every ``<attachment>`` block found in *text*."""
    if "<attachment>" not in text:
        return text

    def _replace(match: re.Match[str]) -> str:
        rendered = _preview_attachment_body(match.group(1), total_limit, counter)
        return f"<attachment>{rendered}</attachment>"

    return _ATTACHMENT_BLOCK.sub(_replace, text)


def apply_attachment_preview(
    messages: list[dict[str, Any]],
    *,
    token_counter: TokenCounter,
    limit: int,
) -> list[dict[str, Any]]:
    """Return *messages* with every inline ``<attachment>`` body token-bounded.

    Input dicts are not mutated; only messages that actually carry an attachment
    block are copied and rewritten.
    """
    if limit <= 0:
        return messages

    started = time.perf_counter()
    saw_attachment = False
    truncated_blocks = 0
    before_tokens = 0
    after_tokens = 0

    def _preview_block_text(text: str) -> str:
        nonlocal saw_attachment, truncated_blocks, before_tokens, after_tokens
        if "<attachment>" not in text:
            return text
        saw_attachment = True
        new_text = _preview_text(text, limit, token_counter)
        if new_text is not text:
            truncated_blocks += 1
            before_tokens += token_counter.count_text(text)
            after_tokens += token_counter.count_text(new_text)
        return new_text

    result: list[dict[str, Any]] = []
    for message in messages:
        content = message.get("content")

        if isinstance(content, str):
            new_content = _preview_block_text(content)
            if new_content is not content:
                message = {**message, "content": new_content}

        elif isinstance(content, list):
            new_blocks: list[Any] = []
            changed = False
            for block in content:
                if (
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and isinstance(block.get("text"), str)
                ):
                    new_text = _preview_block_text(block["text"])
                    if new_text is not block["text"]:
                        block = {**block, "text": new_text}
                        changed = True
                new_blocks.append(block)
            if changed:
                message = {**message, "content": new_blocks}

        result.append(message)

    if saw_attachment:
        record_protection_trace(
            "attachment_preview",
            "applied" if truncated_blocks else "noop",
            duration_ms=(time.perf_counter() - started) * 1000,
            before_tokens=before_tokens if truncated_blocks else None,
            after_tokens=after_tokens if truncated_blocks else None,
            attachment_blocks_truncated=truncated_blocks,
        )

    return result
