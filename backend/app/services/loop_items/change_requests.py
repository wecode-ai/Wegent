# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Derived PR/MR links indexed when Issue content is written."""

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from fastapi import HTTPException

from app.core.config import settings
from app.services.issue_badges import issue_badges, replace_badge_source
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models.delivery import LoopItem

_LEGACY_URL = re.compile(r"""https?://[^\s<>"'`\])}]+""")
_URL = re.compile(
    r"""https?://[^\s<>"'`\])}（）【】］》」』”’、。，；：！？]+""",
    re.IGNORECASE,
)
_LEGACY_TRAILING_PUNCTUATION = ".,;:!?。，；：！？"
_TRAILING_PUNCTUATION = _LEGACY_TRAILING_PUNCTUATION + "、）]】］〉》」』”’"
_PATHS = (
    ("github", re.compile(r"^(/[^/]+/[^/]+)/pull/([1-9]\d*)(?:/.*)?$")),
    ("gitlab", re.compile(r"^(/.+?)/-/merge_requests/([1-9]\d*)(?:/.*)?$")),
)
_CHANGE_REQUEST_SOURCE_PREFIXES = ("comment:", "activity:")


@dataclass(frozen=True)
class ChangeRequestBadgeReindexResult:
    item_id: str
    version: int
    changed: bool


def extract_change_request_urls(
    content: str, *, canonicalize: bool | None = None
) -> list[str]:
    """Extract deduplicated change-request URLs from Issue-authored content."""

    if canonicalize is None:
        canonicalize = settings.COLLAB_CHANGE_REQUEST_BADGE_CANONICALIZATION_V1
    trailing_punctuation = (
        _TRAILING_PUNCTUATION if canonicalize else _LEGACY_TRAILING_PUNCTUATION
    )
    urls: set[str] = set()
    url_pattern = _URL if canonicalize else _LEGACY_URL
    for candidate in url_pattern.findall(content or ""):
        try:
            parsed = urlsplit(candidate.rstrip(trailing_punctuation))
            if not parsed.hostname or parsed.username or parsed.password:
                continue
            for provider, pattern in _PATHS:
                match = pattern.fullmatch(parsed.path)
                if not match or len(match[2]) > 16:
                    continue
                number = int(match[2])
                if number > 2**53 - 1:
                    continue
                marker = "/pull/" if provider == "github" else "/-/merge_requests/"
                scheme = (
                    "https"
                    if canonicalize and provider == "github"
                    else parsed.scheme.lower()
                )
                url = f"{scheme}://{parsed.netloc.lower()}{match[1]}{marker}{number}"
                project_change_request_binding_service._identity_from_url(
                    provider, url, number
                )
                urls.add(url)
                break
        except (ValueError, HTTPException):
            continue
    return sorted(urls)


def update_change_request_source(
    metadata: object, source: str, content: str
) -> dict[str, Any]:
    badges = [
        {
            "id": url,
            "label": f"{'!' if '/-/merge_requests/' in url else '#'}{url.rsplit('/', 1)[-1]}",
            "url": url,
            "icon": "git-pull-request",
            "tone": "neutral",
        }
        for url in extract_change_request_urls(content)
    ]
    return replace_badge_source(metadata, source, badges)


def _issue_badge_sources(db: "Session", item: "LoopItem") -> dict[str, str]:
    from app.models.delivery import LoopItemComment, loop_datetime_is_unset
    from app.models.project_chat_message import ProjectChatMessage
    from app.services.project_chat.service import PROJECT_CHAT_TERMINAL_RUN_STATUSES

    sources = {"issue": f"{item.title}\n{item.description}"}
    comments = (
        db.query(LoopItemComment)
        .filter(
            LoopItemComment.loop_item_id == item.id,
            loop_datetime_is_unset(LoopItemComment.deleted_at),
        )
        .all()
    )
    for comment in comments:
        sources[f"comment:{comment.id}"] = comment.description or ""

    activities = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.task_id == item.id,
            ProjectChatMessage.project_id == str(item.cloud_project_id),
            ProjectChatMessage.status.in_(sorted(PROJECT_CHAT_TERMINAL_RUN_STATUSES)),
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .all()
    )
    for activity in activities:
        sources[f"activity:{activity.message_id}"] = activity.content or ""
    return sources


def _replace_change_request_sources(
    metadata: object, sources: dict[str, str]
) -> dict[str, Any]:
    updated = dict(metadata) if isinstance(metadata, dict) else {}
    stored_sources = updated.get("badge_sources")
    existing_source_names = (
        set(stored_sources) if isinstance(stored_sources, dict) else set()
    )
    change_request_source_names = {
        source
        for source in existing_source_names | set(sources)
        if source == "issue" or source.startswith(_CHANGE_REQUEST_SOURCE_PREFIXES)
    }
    sourced_badge_ids = (
        {
            badge["id"]
            for values in stored_sources.values()
            if isinstance(values, list)
            for badge in values
            if isinstance(badge, dict) and isinstance(badge.get("id"), str)
        }
        if isinstance(stored_sources, dict)
        else set()
    )
    unowned_badges = [
        badge for badge in issue_badges(updated) if badge["id"] not in sourced_badge_ids
    ]
    for source in sorted(change_request_source_names):
        updated = update_change_request_source(updated, source, sources.get(source, ""))
    if unowned_badges:
        updated = replace_badge_source(updated, "unmanaged", unowned_badges)
    return updated


def reindex_change_request_badges(
    db: "Session",
    *,
    project_id: str,
    item_id: str,
    actor_user_id: int = 0,
    commit: bool = True,
) -> ChangeRequestBadgeReindexResult:
    """Rebuild one local Issue's change-request badge sources idempotently."""

    from app.models.delivery import LoopItem, loop_datetime_is_unset

    item = (
        db.query(LoopItem)
        .filter(
            LoopItem.id == item_id,
            LoopItem.cloud_project_id == project_id,
            loop_datetime_is_unset(LoopItem.deleted_at),
        )
        .with_for_update()
        .one_or_none()
    )
    if item is None:
        raise HTTPException(404, "Issue not found")

    previous_metadata = dict(item.metadata_json or {})
    if not settings.COLLAB_CHANGE_REQUEST_BADGE_CANONICALIZATION_V1 or any(
        previous_metadata.get(key) for key in ("external_index", "external_shadow")
    ):
        return ChangeRequestBadgeReindexResult(
            item_id=item.id,
            version=int(item.version),
            changed=False,
        )

    metadata = _replace_change_request_sources(
        previous_metadata, _issue_badge_sources(db, item)
    )

    changed = metadata != previous_metadata
    if changed:
        item.metadata_json = metadata
        item.version += 1
    if commit:
        db.commit()
        if changed:
            from app.services.loop_item_events import publish_loop_item_changed

            refreshed = db.get(LoopItem, item.id)
            if refreshed is not None:
                publish_loop_item_changed(
                    db,
                    item=refreshed,
                    reason="badges",
                    actor_user_id=actor_user_id,
                )
    else:
        db.flush()

    return ChangeRequestBadgeReindexResult(
        item_id=item.id,
        version=int(item.version),
        changed=changed,
    )


def persist_external_badge_source(
    db: "Session", *, project_id: str, item_id: str, source: str, content: str
) -> "LoopItem | None":
    from app.models.delivery import LoopItem

    row = (
        db.query(LoopItem)
        .filter(LoopItem.id == item_id, LoopItem.cloud_project_id == project_id)
        .with_for_update()
        .one_or_none()
    )
    metadata = update_change_request_source(
        row.metadata_json if row else None, source, content
    )
    if row is None:
        if not metadata.get("badges"):
            return None
        row = LoopItem(
            id=item_id,
            cloud_project_id=project_id,
            metadata_json={"external_index": True},
            version=1,
        )
        db.add(row)
    row.metadata_json = {**(row.metadata_json or {}), **metadata}
    db.flush()
    return row
