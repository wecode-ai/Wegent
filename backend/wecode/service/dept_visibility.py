# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
ERP department visibility config stored in Redis.

Hides specific departments from non-whitelisted users when searching via
the internal department auth endpoint. Config lives in a single Redis hash
so HR-driven ad-hoc changes take effect immediately without a redeploy.

Redis layout:
    key:    wecode:erp:dept_visibility
    fields:
        hidden_items     JSON list[str]  Department IDs or names to hide
        whitelist_users  JSON list[str]  user_name values exempt from filter

Hidden list items match against DepartmentInfo.id, .name, or .label
(any one is enough to hide the department).

On Redis failure the filter is fail-open: searches return the full ERP
result. The visibility rule is a soft HR policy, not an auth boundary,
so degraded availability is preferred over a broken search experience.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Iterable, Optional

from wecode.cache.base import get_redis_client
from wecode.service.erp_client import DepartmentInfo

logger = logging.getLogger(__name__)

REDIS_KEY = "wecode:erp:dept_visibility"
FIELD_HIDDEN = "hidden_items"
FIELD_WHITELIST = "whitelist_users"
_VALID_FIELDS = {FIELD_HIDDEN, FIELD_WHITELIST}


@dataclass
class VisibilityConfig:
    hidden_items: set[str] = field(default_factory=set)
    whitelist_users: set[str] = field(default_factory=set)


def _decode(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


def _normalize_list(items: Iterable) -> list[str]:
    """Strip, drop empties, dedupe while preserving first-seen order."""
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item is None:
            continue
        s = str(item).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _read_field(client, field_name: str) -> list[str]:
    raw = client.hget(REDIS_KEY, field_name)
    decoded = _decode(raw)
    if not decoded:
        return []
    try:
        data = json.loads(decoded)
    except json.JSONDecodeError:
        logger.warning(
            f"dept_visibility: corrupt JSON in field {field_name!r}, "
            f"treating as empty"
        )
        return []
    if not isinstance(data, list):
        return []
    return _normalize_list(data)


def get_visibility_config() -> VisibilityConfig:
    """Read full visibility config from Redis. Fail-open on any error."""
    client = get_redis_client()
    if client is None:
        return VisibilityConfig()
    try:
        hidden = _read_field(client, FIELD_HIDDEN)
        whitelist = _read_field(client, FIELD_WHITELIST)
        return VisibilityConfig(
            hidden_items=set(hidden),
            whitelist_users=set(whitelist),
        )
    except Exception as e:
        logger.warning(f"dept_visibility: config read failed, fail-open: {e}")
        return VisibilityConfig()


def write_field(field_name: str, items: list[str]) -> list[str]:
    """Replace one config field. Returns the normalized list actually stored.

    Raises RuntimeError if Redis is unavailable so the admin caller gets a
    clear error instead of a silent no-op.
    """
    if field_name not in _VALID_FIELDS:
        raise ValueError(f"Unknown field: {field_name}")

    client = get_redis_client()
    if client is None:
        raise RuntimeError("Redis is not available")

    normalized = _normalize_list(items)
    client.hset(REDIS_KEY, field_name, json.dumps(normalized, ensure_ascii=False))
    return normalized


def is_hidden(dept: DepartmentInfo, hidden_set: set[str]) -> bool:
    """A department is hidden if its id, name, or label is in hidden_set."""
    candidates: list[str] = []
    if dept.id is not None:
        candidates.append(str(dept.id))
    if dept.name:
        candidates.append(dept.name)
    if dept.label:
        candidates.append(dept.label)
    return any(c in hidden_set for c in candidates)


def filter_hidden_for_user(
    user_name: Optional[str], departments: list[DepartmentInfo]
) -> list[DepartmentInfo]:
    """Drop hidden departments unless the user is whitelisted."""
    config = get_visibility_config()
    if not config.hidden_items:
        return departments
    if user_name and user_name in config.whitelist_users:
        return departments
    return [d for d in departments if not is_hidden(d, config.hidden_items)]
