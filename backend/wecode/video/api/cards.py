# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""AIGC-specific card state mapping built on the common card block contract."""

from typing import Any

from shared.models.blocks import create_card_block


def create_pending_card_block(
    *,
    card_id: str,
    card_type: str,
    preview_title: str,
    progress_text: str,
) -> dict[str, Any]:
    return create_card_block(
        card_id=card_id,
        card_type=card_type,
        card_status="pending",
        card_preview_data={
            "title": preview_title,
            "progress_text": progress_text,
            "progress": 0,
        },
    )


def update_card_block(
    block: dict[str, Any],
    *,
    card_status: str,
    card_data: dict[str, Any] | None = None,
    progress: int | None = None,
    progress_text: str = "",
    error: str = "",
) -> dict[str, Any]:
    updated = dict(block)
    preview = dict(updated.get("card_preview_data") or {})
    if progress is not None:
        preview["progress"] = progress
    if progress_text:
        preview["progress_text"] = progress_text
    updated["card_preview_data"] = preview
    updated["card_status"] = card_status
    updated["status"] = "error" if card_status == "error" else "done"
    if card_data is not None:
        updated["card_data"] = card_data
    if error:
        updated["card_error"] = error
    return updated
