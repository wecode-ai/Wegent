# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Temporary download URLs for generated images."""

from datetime import timedelta
from typing import Any

from app.core.config import settings
from app.services.attachment.public_link import (
    build_public_attachment_download_url,
)

IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS = 3600


def build_image_download_url(attachment_id: int) -> str:
    """Create a one-hour public download URL for a generated image."""
    return build_public_attachment_download_url(
        attachment_id,
        timedelta(seconds=IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS),
        settings.WEGENT_BACKEND_PUBLIC_URL,
    )


def refresh_image_result_download_urls(result: Any) -> Any:
    """Return an image result with fresh temporary download URLs."""
    if not isinstance(result, dict):
        return result

    blocks = result.get("blocks")
    if not isinstance(blocks, list):
        return result

    refreshed_blocks: list[Any] | None = None
    for index, block in enumerate(blocks):
        if not isinstance(block, dict) or block.get("type") != "image":
            continue
        attachment_ids = block.get("image_attachment_ids")
        if not isinstance(attachment_ids, list):
            continue
        valid_ids = [
            attachment_id
            for attachment_id in attachment_ids
            if isinstance(attachment_id, int)
        ]
        if not valid_ids:
            continue
        if refreshed_blocks is None:
            refreshed_blocks = list(blocks)
        refreshed_block = dict(block)
        refreshed_block["image_download_urls"] = [
            build_image_download_url(attachment_id) for attachment_id in valid_ids
        ]
        refreshed_block["image_download_url_expires_in_seconds"] = (
            IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS
        )
        refreshed_blocks[index] = refreshed_block

    if refreshed_blocks is None:
        return result
    refreshed = dict(result)
    refreshed["blocks"] = refreshed_blocks
    return refreshed


def refresh_task_image_download_urls(task_dict: dict[str, Any]) -> None:
    """Refresh generated-image download URLs in a task detail response."""
    task_dict["result"] = refresh_image_result_download_urls(task_dict.get("result"))
    subtasks = task_dict.get("subtasks")
    if not isinstance(subtasks, list):
        return
    for subtask in subtasks:
        if isinstance(subtask, dict):
            subtask["result"] = refresh_image_result_download_urls(
                subtask.get("result")
            )
