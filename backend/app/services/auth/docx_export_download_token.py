# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Short-lived tokens for DOCX export downloads in browsers.

Browsers such as Safari and in-app webviews may ignore client-side blob
downloads, so the frontend navigates to the export URL with a tokenized query
parameter instead. These tokens are bound to a single task, user, and message
filter, and are only valid for a short period.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from app.core.config import settings

logger = logging.getLogger(__name__)

DOCX_EXPORT_TOKEN_TYPE = "docx_export_download_token"


@dataclass
class DocxExportDownloadTokenInfo:
    """Decoded token data for a DOCX export download."""

    task_id: int
    user_id: int
    user_name: str
    message_ids_hash: Optional[str]
    expire_at: Optional[int] = None


def _normalize_message_ids(message_ids: Optional[str]) -> str:
    """Normalize the message_ids query parameter into a stable digest input."""
    if message_ids is None:
        return ""
    ids = [part.strip() for part in message_ids.split(",") if part.strip()]
    return ",".join(ids)


def message_ids_hash(message_ids: Optional[str]) -> Optional[str]:
    """Return a stable SHA-256 hash of the message_ids filter, or None."""
    normalized = _normalize_message_ids(message_ids)
    if not normalized:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def create_docx_export_download_token(
    *,
    task_id: int,
    user_id: int,
    user_name: str,
    message_ids: Optional[str] = None,
    expires_delta_minutes: int = 5,
) -> str:
    """Create a short-lived token bound to a specific DOCX export request."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=expires_delta_minutes)
    payload = {
        "type": DOCX_EXPORT_TOKEN_TYPE,
        "task_id": task_id,
        "user_id": user_id,
        "user_name": user_name,
        "message_ids_hash": message_ids_hash(message_ids),
        "exp": expire,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_docx_export_download_token(
    token: str,
    *,
    task_id: int,
    message_ids: Optional[str] = None,
) -> Optional[DocxExportDownloadTokenInfo]:
    """Verify a DOCX export download token for the given task and filter."""
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
    except jwt.ExpiredSignatureError:
        logger.warning("DOCX export download token has expired")
        return None
    except jwt.InvalidTokenError as exc:
        logger.warning("Invalid DOCX export download token: %s", exc)
        return None

    if payload.get("type") != DOCX_EXPORT_TOKEN_TYPE:
        logger.warning("Invalid DOCX export token type")
        return None

    if payload.get("task_id") != task_id:
        logger.warning("DOCX export token task mismatch")
        return None

    expected_hash = message_ids_hash(message_ids)
    if payload.get("message_ids_hash") != expected_hash:
        logger.warning("DOCX export token message_ids mismatch")
        return None

    user_id = payload.get("user_id")
    user_name = payload.get("user_name")
    if not isinstance(user_id, int) or not isinstance(user_name, str):
        logger.warning("DOCX export token missing user info")
        return None

    return DocxExportDownloadTokenInfo(
        task_id=task_id,
        user_id=user_id,
        user_name=user_name,
        message_ids_hash=expected_hash,
        expire_at=payload.get("exp"),
    )
