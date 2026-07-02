# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for replaying external web content contexts into LLM input."""

import logging
from html import escape
from typing import List

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext

logger = logging.getLogger(__name__)


def resolve_external_web_content_owner_id(
    external_contexts: list[SubtaskContext],
    fallback_user_id: int,
) -> int:
    """Return the owner used for loading external web asset contexts."""
    for context in external_contexts:
        if context.user_id:
            return context.user_id
    return fallback_user_id


def is_external_web_content_asset(context: SubtaskContext) -> bool:
    """Return whether the attachment is an internal external-web asset."""
    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    return type_data.get("source") == "external_web_content"


def expand_external_web_content_assets(
    db: Session,
    external_contexts: List[SubtaskContext],
    user_id: int,
) -> List[SubtaskContext]:
    """Load video/comment attachments referenced by external web contexts."""
    ordered_asset_ids: List[int] = []
    seen_ids: set[int] = set()
    for context in external_contexts:
        if context.user_id != user_id or not isinstance(context.type_data, dict):
            continue
        asset_context_ids = context.type_data.get("asset_context_ids") or {}
        if not isinstance(asset_context_ids, dict):
            continue
        for group_name in ("videos", "comments"):
            group_ids = asset_context_ids.get(group_name) or []
            if not isinstance(group_ids, list):
                continue
            for asset_id in group_ids:
                if isinstance(asset_id, int) and asset_id not in seen_ids:
                    ordered_asset_ids.append(asset_id)
                    seen_ids.add(asset_id)

    if not ordered_asset_ids:
        return []

    assets = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(ordered_asset_ids),
            SubtaskContext.user_id == user_id,
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            SubtaskContext.status == ContextStatus.READY.value,
        )
        .all()
    )
    assets_by_id = {asset.id: asset for asset in assets}
    expanded_assets = [
        assets_by_id[asset_id]
        for asset_id in ordered_asset_ids
        if asset_id in assets_by_id
    ]
    missing_count = len(ordered_asset_ids) - len(expanded_assets)
    if missing_count:
        logger.warning(
            "[external_web_content] skipped missing assets user_id=%s missing=%s",
            user_id,
            missing_count,
        )
    return expanded_assets


def build_external_web_content_images(
    external_contexts: List[SubtaskContext],
) -> List[dict]:
    """Build OpenAI image contents from aggregate contexts."""
    image_contents: List[dict] = []
    for context in external_contexts:
        if not isinstance(context.type_data, dict):
            continue
        image_urls = context.type_data.get("image_urls") or []
        if not isinstance(image_urls, list):
            continue

        for index, image in enumerate(image_urls, start=1):
            if isinstance(image, str):
                image_url = image.strip()
                source_index = index - 1
            elif isinstance(image, dict):
                raw_url = image.get("url")
                if not isinstance(raw_url, str):
                    continue
                image_url = raw_url.strip()
                source_index = image.get("source_index", index - 1)
            else:
                continue

            if not image_url:
                continue

            image_contents.append(
                {
                    "image_url": image_url,
                    "url": image_url,
                    "source_index": source_index,
                }
            )
    return image_contents


def build_external_web_content_texts(
    external_contexts: List[SubtaskContext],
) -> List[str]:
    """Build page text snippets from external web aggregate contexts."""
    text_contents: List[str] = []
    for context in external_contexts:
        if not isinstance(context.type_data, dict):
            continue
        title = context.type_data.get("title")
        body = context.type_data.get("body")
        if not title and not body:
            continue

        lines = [
            f"[External Web Content: {context.name}]",
            f"Source: {context.type_data.get('external_source_url') or ''}",
        ]
        if context.type_data.get("site"):
            lines.append(f"Site: {context.type_data['site']}")
        if title:
            lines.append(f"Title: {title}")
        if context.type_data.get("author_name"):
            lines.append(f"Author: {context.type_data['author_name']}")
        if context.type_data.get("publish_time"):
            lines.append(f"Published at: {context.type_data['publish_time']}")
        if body:
            lines.extend(["", "Body:", escape(str(body))])
        text_contents.append("\n".join(lines).strip() + "\n\n")
    return text_contents
