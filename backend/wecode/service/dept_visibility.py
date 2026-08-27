# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""ERP-backed department visibility filtering.

ERP owns the hidden department list. Departments returned by the ERP
``/api/open/search?keyword=T2`` query are hidden from non-whitelisted users.
Only the local user whitelist is maintained in Redis.

Redis layout::

    key:    wecode:erp:dept_visibility
    field:  whitelist_users  JSON list[str]  user_name values exempt from filter
    key:    wecode:erp:dept_visibility:t2_ids:v1
    value:  JSON list[str]  Department IDs returned by the ERP T2 search
    ttl:    300 seconds

The visibility rule is a soft HR policy, not an auth boundary. Redis and ERP
failures therefore fail open and preserve the full department search result.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Iterable, Optional

from wecode.cache.base import get_redis_client
from wecode.service.erp_client import DepartmentInfo, erp_client

logger = logging.getLogger(__name__)

REDIS_KEY = "wecode:erp:dept_visibility"
FIELD_WHITELIST = "whitelist_users"
HIDDEN_DEPARTMENT_CACHE_KEY = "wecode:erp:dept_visibility:t2_ids:v1"
HIDDEN_DEPARTMENT_CACHE_TTL = 300
_VALID_FIELDS = {FIELD_WHITELIST}


@dataclass
class VisibilityConfig:
    whitelist_users: set[str] = field(default_factory=set)
    redis_available: bool = True


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
        value = str(item).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
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
            "treating as empty"
        )
        return []
    if not isinstance(data, list):
        return []
    return _normalize_list(data)


def get_visibility_config() -> VisibilityConfig:
    """Read the local whitelist from Redis. Fail-open on any error."""
    client = get_redis_client()
    if client is None:
        return VisibilityConfig(redis_available=False)
    try:
        return VisibilityConfig(
            whitelist_users=set(_read_field(client, FIELD_WHITELIST))
        )
    except Exception as e:
        logger.warning(f"dept_visibility: config read failed, fail-open: {e}")
        return VisibilityConfig(redis_available=False)


def write_field(field_name: str, items: list[str]) -> list[str]:
    """Replace the local whitelist field with normalized values."""
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


def _normalize_department_id(value: object) -> str:
    """Normalize department IDs consistently across ERP and search results."""
    value_str = str(value).strip()
    return str(int(value_str)) if value_str.isdigit() else value_str


def _read_hidden_department_cache(client) -> Optional[set[str]]:
    """Read cached T2 department IDs, returning None on miss or error."""
    try:
        raw = client.get(HIDDEN_DEPARTMENT_CACHE_KEY)
        if raw is None:
            return None
        decoded = _decode(raw)
        data = json.loads(decoded)
        if not isinstance(data, list):
            logger.warning("dept_visibility: invalid T2 cache format")
            return None
        return {_normalize_department_id(item) for item in data if item is not None}
    except Exception as e:
        logger.warning(f"dept_visibility: T2 cache read failed: {e}")
        return None


def get_hidden_department_ids() -> Optional[set[str]]:
    """Get T2 department IDs from Redis or ERP.

    None means the visibility data could not be resolved and callers should
    fail open. An empty set is a valid successful ERP response.
    """
    client = get_redis_client()
    if client is None:
        return None

    cached = _read_hidden_department_cache(client)
    if cached is not None:
        return cached

    hidden_ids = erp_client.search_hidden_department_ids()
    if hidden_ids is None:
        return None

    normalized_ids = {_normalize_department_id(item) for item in hidden_ids}
    try:
        client.set(
            HIDDEN_DEPARTMENT_CACHE_KEY,
            json.dumps(sorted(normalized_ids)),
            ex=HIDDEN_DEPARTMENT_CACHE_TTL,
        )
    except Exception as e:
        logger.warning(f"dept_visibility: T2 cache write failed: {e}")
    return normalized_ids


def filter_hidden_for_user(
    user_name: Optional[str], departments: list[DepartmentInfo]
) -> list[DepartmentInfo]:
    """Drop ERP T2 departments unless the user is whitelisted."""
    config = get_visibility_config()
    if not config.redis_available:
        return departments
    if user_name and user_name in config.whitelist_users:
        return departments

    hidden_ids = get_hidden_department_ids()
    if hidden_ids is None:
        return departments
    return [
        department
        for department in departments
        if department.id is None
        or _normalize_department_id(department.id) not in hidden_ids
    ]
