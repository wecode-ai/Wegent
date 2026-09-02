# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""JWT authentication utilities for Chat Service.

This module provides JWT token verification for WebSocket connections.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from jose import jwt
from jose.exceptions import ExpiredSignatureError

from app.core.config import settings
from app.core.payload_codec import run_payload_codec
from app.core.session_token import is_user_session_payload
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuthenticatedUser:
    """Detached user fields safe to carry across an async boundary."""

    id: int
    user_name: str
    email: str
    is_active: bool


def verify_jwt_token(token: str) -> Optional[AuthenticatedUser]:
    """
    Verify JWT token and return user.

    Args:
        token: JWT token string

    Returns:
        User object if valid, None otherwise
    """
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        if not is_user_session_payload(payload):
            logger.debug("JWT is not a chat session token")
            return None
        user_name = payload.get("sub")
        if not user_name:
            return None

        # Get user from database
        db = SessionLocal()
        try:
            from app.models.user import User

            row = (
                db.query(User.id, User.user_name, User.email, User.is_active)
                .filter(User.user_name == user_name)
                .first()
            )
            if row is None:
                return None
            return AuthenticatedUser(
                id=row.id,
                user_name=row.user_name,
                email=row.email or "",
                is_active=bool(row.is_active),
            )
        finally:
            db.close()

    except Exception as e:
        logger.warning(f"JWT verification failed: {e}")
        return None


async def verify_jwt_token_async(token: str) -> Optional[AuthenticatedUser]:
    """Verify a JWT without running crypto or SQLAlchemy on the event loop."""
    from app.services.chat.storage.db import run_sync_in_executor

    return await run_sync_in_executor(verify_jwt_token, token)


def is_token_expired(token: str) -> bool:
    """
    Check if JWT token is expired without throwing exception.

    Args:
        token: JWT token string

    Returns:
        True if token is expired or invalid, False otherwise
    """
    try:
        jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return False
    except ExpiredSignatureError:
        return True
    except Exception:
        return True


def get_token_expiry(token: str) -> Optional[int]:
    """
    Extract expiry timestamp from JWT token without verifying signature.

    Args:
        token: JWT token string

    Returns:
        Expiry timestamp in seconds (Unix timestamp), or None if invalid
    """
    try:
        # Decode without verification to extract expiry
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            options={"verify_exp": False},
        )
        return payload.get("exp")
    except Exception:
        return None


async def get_token_expiry_async(token: str) -> Optional[int]:
    """Extract token expiry without running JWT crypto on the event loop."""
    return await run_payload_codec(
        get_token_expiry,
        token,
        payload_hint=token,
        force_offload=True,
    )
