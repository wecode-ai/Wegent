# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Signed public links for attachment downloads."""

import secrets
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt

from app.core.config import settings


class InvalidPublicAttachmentToken(ValueError):
    """Raised when a public attachment token is invalid or expired."""


def generate_public_attachment_token(
    attachment_id: int,
    expires_delta: timedelta,
) -> str:
    """Create a signed token scoped to one attachment."""
    now = datetime.now(timezone.utc)
    payload = {
        "attachment_id": attachment_id,
        "purpose": "public_attachment_download",
        "nonce": secrets.token_urlsafe(16),
        "iat": now,
        "exp": now + expires_delta,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_public_attachment_token(token: str) -> dict:
    """Verify and return a public attachment token payload."""
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
    except JWTError as exc:
        raise InvalidPublicAttachmentToken("Invalid public attachment token") from exc

    attachment_id = payload.get("attachment_id")
    if (
        payload.get("purpose") != "public_attachment_download"
        or not isinstance(attachment_id, int)
        or not payload.get("nonce")
    ):
        raise InvalidPublicAttachmentToken("Invalid public attachment token payload")

    return payload
