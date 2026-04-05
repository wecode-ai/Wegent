# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Short-lived token helpers for internal RAG attachment downloads."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class RagDownloadTokenInfo:
    """Decoded token data for internal RAG attachment download."""

    attachment_id: int


def create_rag_download_token(
    *,
    attachment_id: int,
    expires_delta_seconds: int = 300,
) -> str:
    """Create a short-lived token bound to a single attachment ID."""

    expire = datetime.now(timezone.utc) + timedelta(seconds=expires_delta_seconds)
    payload = {
        "attachment_id": attachment_id,
        "exp": expire,
        "type": "rag_download_token",
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_rag_download_token(token: str) -> Optional[RagDownloadTokenInfo]:
    """Verify a short-lived token for internal RAG attachment download."""

    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        if payload.get("type") != "rag_download_token":
            logger.warning("Invalid RAG download token type")
            return None

        attachment_id = payload.get("attachment_id")
        if not isinstance(attachment_id, int):
            logger.warning("RAG download token missing attachment_id")
            return None

        return RagDownloadTokenInfo(attachment_id=attachment_id)
    except jwt.ExpiredSignatureError:
        logger.warning("RAG download token has expired")
        return None
    except jwt.InvalidTokenError as exc:
        logger.warning("Invalid RAG download token: %s", exc)
        return None
