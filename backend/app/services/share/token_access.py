"""Authorization for persisted opaque and legacy share links."""

import hashlib
from collections.abc import Callable
from typing import Optional
from urllib.parse import unquote

from fastapi import HTTPException
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.share_link import ShareLink
from app.models.user import User


def hash_share_token(token: str) -> str:
    """Normalize legacy URL quoting before hashing; opaque tokens are unchanged."""
    return hashlib.sha256(unquote(token).encode("utf-8")).hexdigest()


def share_token_lookup(token: str) -> ColumnElement[bool]:
    """Match a persisted token, including hashless rows from old writers."""
    digest = hash_share_token(token)
    recorded_digest = func.sha2(
        func.replace(func.replace(ShareLink.share_token, "%2B", "+"), "%3D", "="),
        256,
    )
    return or_(
        ShareLink.token_hash == digest,
        and_(
            ShareLink.token_hash.is_(None),
            ShareLink.token_version == ShareLink.LEGACY_TOKEN_VERSION,
            recorded_digest == digest,
        ),
    )


def require_share_link_access(
    db: Session,
    link: ShareLink,
    viewer_id: Optional[int],
    can_read: Callable[[int], object],
) -> None:
    """Legacy tokens locate resources but never grant access to them."""
    if not link.is_active or link.is_expired:
        raise HTTPException(
            status_code=400, detail="Share link has expired or is inactive"
        )
    if link.token_version == ShareLink.OPAQUE_TOKEN_VERSION:
        return
    if link.token_version != ShareLink.LEGACY_TOKEN_VERSION:
        raise HTTPException(status_code=400, detail="Invalid share token")
    if viewer_id is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required for legacy share link",
            headers={"WWW-Authenticate": "Bearer"},
        )
    active_user = (
        db.query(User.id).filter(User.id == viewer_id, User.is_active.is_(True)).first()
    )
    if not active_user or not can_read(viewer_id):
        raise HTTPException(
            status_code=403, detail="Legacy share link requires resource access"
        )
