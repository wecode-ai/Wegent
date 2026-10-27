# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Source-owned, business-independent Issue badges stored in metadata."""

from typing import Any


def issue_badges(metadata: object) -> list[dict[str, Any]]:
    values = metadata.get("badges") if isinstance(metadata, dict) else None
    if not isinstance(values, list):
        return []
    return [
        dict(value)
        for value in values
        if isinstance(value, dict)
        and isinstance(value.get("id"), str)
        and isinstance(value.get("label"), str)
    ]


def replace_badge_source(
    metadata: object, source: str, badges: list[dict[str, Any]]
) -> dict[str, Any]:
    updated = dict(metadata) if isinstance(metadata, dict) else {}
    previous = updated.get("badge_sources")
    sources = dict(previous) if isinstance(previous, dict) else {}
    if not badges and source not in sources:
        return updated
    if not isinstance(previous, dict) and issue_badges(updated):
        sources["unmanaged"] = issue_badges(updated)
    if badges:
        sources[source] = badges
    else:
        sources.pop(source, None)
    by_id = {
        badge["id"]: badge
        for values in sources.values()
        if isinstance(values, list)
        for badge in values
        if isinstance(badge, dict) and isinstance(badge.get("id"), str)
    }
    updated["badge_sources"] = sources
    updated["badges"] = [by_id[key] for key in sorted(by_id)]
    return updated
