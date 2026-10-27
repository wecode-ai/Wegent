# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Derived PR/MR links indexed when Issue content is written."""

import re
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from fastapi import HTTPException

from app.services.issue_badges import replace_badge_source
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models.delivery import LoopItem

_URL = re.compile(r"""https?://[^\s<>"'`\])}]+""")
_PATHS = (
    ("github", re.compile(r"^(/[^/]+/[^/]+)/pull/([1-9]\d*)(?:/.*)?$")),
    ("gitlab", re.compile(r"^(/.+?)/-/merge_requests/([1-9]\d*)(?:/.*)?$")),
)


def extract_change_request_urls(content: str) -> list[str]:
    urls: set[str] = set()
    for candidate in _URL.findall(content or ""):
        try:
            parsed = urlsplit(candidate.rstrip(".,;:!?。，；：！？"))
            if not parsed.hostname or parsed.username or parsed.password:
                continue
            for provider, pattern in _PATHS:
                match = pattern.fullmatch(parsed.path)
                if not match or int(match[2]) > 2**53 - 1:
                    continue
                marker = "/pull/" if provider == "github" else "/-/merge_requests/"
                url = f"{parsed.scheme}://{parsed.netloc.lower()}{match[1]}{marker}{match[2]}"
                project_change_request_binding_service._identity_from_url(
                    provider, url, int(match[2])
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
