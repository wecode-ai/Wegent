# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""``read_attachment`` tool — paginated read of an attachment's extracted text.

Complements the inline attachment preview: the preview shows a bounded head/tail
of each attachment; this tool lets the model page through the full extracted text
(mainly for binary attachments — pdf/ppt/docx — whose sandbox file is not
directly readable as text; text attachments can be read from the sandbox).

Pagination uses a **character offset** cursor (tokenizer-independent, stable
across turns/models) with a **token-clamped page**: a page never exceeds the
per-page token budget, so the request-level tool-output guard never has to
re-truncate it (which would break page contiguity). Content upper bound is the
parse-time extracted-text cap; beyond that the original file must be read from
the sandbox. Access is task-scoped by the backend endpoint / DB query.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.history.attachment_text import (
    AttachmentNotAvailable,
    fetch_attachment_text,
)

logger = logging.getLogger(__name__)

# Default per-page token budget. Aligned with the tool-output budget so a page
# stays within what the request-level guard allows (no re-truncation).
DEFAULT_PAGE_TOKEN_LIMIT = 15000
# Chars requested per fetch ~ 4x the token budget (English ≈ 4 chars/token); the
# slice is then token-clamped down. Bounds how much text crosses the wire.
_CHARS_PER_TOKEN = 4


class ReadAttachmentInput(BaseModel):
    """Input schema for the read_attachment tool."""

    attachment_id: int = Field(
        description="Attachment id, shown as 'ID: <n>' in the <attachment> block"
    )
    offset: int = Field(
        default=0, description="Start character offset (0-indexed codepoint)"
    )
    limit: int = Field(
        default=0,
        description="Max characters to read (0 = use default; page is also "
        "token-bounded so the actual returned size may be smaller)",
    )


class ReadAttachmentTool(BaseTool):
    """Read an attachment's extracted text with character-offset pagination."""

    name: str = "read_attachment"
    description: str = (
        "Read the full extracted text of an attachment by id, with pagination. "
        "Use this for binary attachments (pdf/ppt/docx) whose content was shown "
        "only as a truncated preview. Returns a page of text plus next_offset / "
        "has_more for paging."
    )
    args_schema: type[BaseModel] = ReadAttachmentInput

    task_id: int
    token_counter: TokenCounter
    page_token_limit: int = DEFAULT_PAGE_TOKEN_LIMIT
    max_calls: int = 30
    _call_count: int = PrivateAttr(default=0)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, *args: Any, **kwargs: Any) -> str:
        raise NotImplementedError("read_attachment is async-only; use _arun")

    async def _arun(
        self, attachment_id: int, offset: int = 0, limit: int = 0, **_: Any
    ) -> str:
        if self._call_count >= self.max_calls:
            return json.dumps(
                {
                    "status": "rejected",
                    "message": f"read_attachment call limit ({self.max_calls}) reached",
                }
            )
        self._call_count += 1

        offset = max(0, offset)
        char_window = limit if limit > 0 else self.page_token_limit * _CHARS_PER_TOKEN

        try:
            payload = await fetch_attachment_text(
                task_id=self.task_id,
                attachment_id=attachment_id,
                offset=offset,
                limit=char_window,
            )
        except AttachmentNotAvailable as exc:
            return json.dumps({"status": "error", "message": str(exc)})
        except Exception as exc:  # network / HTTP errors
            logger.warning("[read_attachment] fetch failed: %s", exc)
            return json.dumps(
                {"status": "error", "message": "Attachment could not be read"}
            )

        text = payload.get("text", "")
        total_chars = int(payload.get("total_chars", 0))
        if not text and total_chars == 0:
            return json.dumps(
                {
                    "status": "empty",
                    "attachment_id": attachment_id,
                    "message": "Attachment has no extractable text",
                }
            )

        # Token-clamp the page so it never exceeds the per-page budget. The char
        # cursor advances only by the chars actually kept, so next_offset stays
        # honest even when the clamp shortens the slice.
        clamped = self._clamp_to_tokens(text, self.page_token_limit)
        chars_read = len(clamped)
        next_offset = offset + chars_read
        has_more = next_offset < total_chars

        return json.dumps(
            {
                "status": "success",
                "attachment_id": attachment_id,
                "name": payload.get("name", ""),
                "mime_type": payload.get("mime_type", ""),
                "offset": offset,
                "chars_read": chars_read,
                "total_chars": total_chars,
                "next_offset": next_offset if has_more else None,
                "has_more": has_more,
                "content": clamped,
            },
            ensure_ascii=False,
        )

    def _clamp_to_tokens(self, text: str, token_limit: int) -> str:
        """Return the longest prefix of *text* within *token_limit* tokens."""
        encoding = self.token_counter.encoding
        ids = encoding.encode(text, disallowed_special=())
        if len(ids) <= token_limit:
            return text
        return encoding.decode(ids[:token_limit])
