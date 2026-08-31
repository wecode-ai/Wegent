# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dedicated authentication for protected plugin release jobs."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, Header, HTTPException, status
from fastapi.security.utils import get_authorization_scheme_param
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.api_key import KEY_TYPE_PLUGIN_RELEASE, APIKey

PLUGIN_RELEASE_SCOPE = "plugins:release"


def _utcnow_naive() -> datetime:
    """Return UTC in the naive form used by existing API key columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass(frozen=True)
class PluginReleasePrincipal:
    key_id: int
    key_name: str
    key_prefix: str
    scopes: frozenset[str]
    restrictions: dict[str, Any]


def verify_plugin_release_key(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> PluginReleasePrincipal:
    """Authenticate a release key without entering user impersonation auth."""
    scheme, raw_key = get_authorization_scheme_param(authorization)
    raw_key = raw_key.strip()
    if scheme.lower() != "bearer" or not raw_key.startswith("wg-") or "#" in raw_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A plugin_release Bearer token is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    key_hash = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
    record = (
        db.query(APIKey)
        .filter(
            APIKey.key_hash == key_hash,
            APIKey.key_type == KEY_TYPE_PLUGIN_RELEASE,
            APIKey.is_active.is_(True),
        )
        .first()
    )
    if not record or record.expires_at <= _utcnow_naive():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Plugin release token is invalid or expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    scopes = frozenset(str(scope) for scope in (record.scopes_json or []))
    if PLUGIN_RELEASE_SCOPE not in scopes:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Plugin release token is missing plugins:release scope",
        )
    record.last_used_at = _utcnow_naive()
    db.commit()
    return PluginReleasePrincipal(
        key_id=record.id,
        key_name=record.name,
        key_prefix=record.key_prefix,
        scopes=scopes,
        restrictions=dict(record.restrictions_json or {}),
    )


def ensure_plugin_release_allowed(
    principal: PluginReleasePrincipal,
    *,
    project_id: str,
    catalog_namespace: str = "enterprise",
    environment: str = "production",
) -> None:
    restrictions = principal.restrictions
    project_ids = {str(value) for value in restrictions.get("projectIds") or []}
    namespaces = {str(value) for value in restrictions.get("catalogNamespaces") or []}
    environments = {str(value) for value in restrictions.get("environments") or []}
    if not project_ids or project_id not in project_ids:
        raise HTTPException(status_code=403, detail="Release project is not allowed")
    if not namespaces or catalog_namespace not in namespaces:
        raise HTTPException(
            status_code=403, detail="Release catalog namespace is not allowed"
        )
    if not environments or environment not in environments:
        raise HTTPException(
            status_code=403, detail="Release environment is not allowed"
        )
