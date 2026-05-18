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

Hidden list items are matched against either DepartmentInfo.id (numeric/string
ID match) or DepartmentInfo.name/label (string-name match). Items are stored
as a single list; matching is type-aware so a department name that happens
to equal another department's id will not cause cross-type collisions.

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

    Raises RuntimeError if Redis is unavailable or the write itself fails so
    the admin caller sees a clear error instead of a silent no-op.
    """
    if field_name not in _VALID_FIELDS:
        raise ValueError(f"Unknown field: {field_name}")

    client = get_redis_client()
    if client is None:
        raise RuntimeError("Redis is not available")

    normalized = _normalize_list(items)
    try:
        client.hset(REDIS_KEY, field_name, json.dumps(normalized, ensure_ascii=False))
    except Exception as e:
        logger.error(f"dept_visibility: failed to write field {field_name!r}: {e}")
        raise RuntimeError(f"Failed to write visibility config: {e}") from e
    return normalized


def _split_hidden_items(hidden_items: set[str]) -> tuple[set[str], set[str]]:
    """Split mixed hidden list into id-like and name-like buckets.

    A purely numeric token is treated as a department ID; everything else
    is treated as a department name/label. Departments are then matched
    by-type so a department name that happens to equal another department's
    numeric id does not cause cross-type false hides.
    """
    ids: set[str] = set()
    names: set[str] = set()
    for item in hidden_items:
        if item.isdigit():
            ids.add(item)
        else:
            names.add(item)
    return ids, names


def is_hidden(
    dept: DepartmentInfo,
    hidden_items: set[str],
    hidden_ids: Optional[set[str]] = None,
    hidden_names: Optional[set[str]] = None,
) -> bool:
    """Return True if the department should be hidden.

    Matching is type-aware: numeric tokens in the hidden list match
    against DepartmentInfo.id only, and non-numeric tokens match against
    DepartmentInfo.name/label only.

    Callers may pre-split the hidden list and pass `hidden_ids` /
    `hidden_names` to avoid repeated splitting in tight loops.
    """
    if hidden_ids is None or hidden_names is None:
        hidden_ids, hidden_names = _split_hidden_items(hidden_items)

    if dept.id is not None and str(dept.id) in hidden_ids:
        return True
    if dept.name and dept.name in hidden_names:
        return True
    if dept.label and dept.label in hidden_names:
        return True
    return False


def filter_hidden_for_user(
    user_name: Optional[str], departments: list[DepartmentInfo]
) -> list[DepartmentInfo]:
    """Drop hidden departments unless the user is whitelisted."""
    config = get_visibility_config()
    if not config.hidden_items:
        return departments
    if user_name and user_name in config.whitelist_users:
        return departments
    hidden_ids, hidden_names = _split_hidden_items(config.hidden_items)
    return [
        d
        for d in departments
        if not is_hidden(d, config.hidden_items, hidden_ids, hidden_names)
    ]
