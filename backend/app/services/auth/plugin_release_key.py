# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dedicated authentication for protected plugin release jobs."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status
from fastapi.security.utils import get_authorization_scheme_param
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.api_key import KEY_TYPE_PLUGIN_RELEASE, APIKey


def _utcnow_naive() -> datetime:
    """Return UTC in the naive form used by existing API key columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass(frozen=True)
class PluginReleasePrincipal:
    key_id: int
    key_name: str
    key_prefix: str


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
    record.last_used_at = _utcnow_naive()
    db.commit()
    return PluginReleasePrincipal(
        key_id=record.id,
        key_name=record.name,
        key_prefix=record.key_prefix,
    )
