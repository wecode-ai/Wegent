# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""JWT authentication utilities for Chat Service.

This module provides JWT token verification for WebSocket connections.
"""

import logging
from typing import Optional

from jose import jwt
from jose.exceptions import ExpiredSignatureError

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.user import User

logger = logging.getLogger(__name__)


def verify_jwt_token(token: str) -> Optional[User]:
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
        user_name = payload.get("sub")
        if not user_name:
            return None

        # Get user from database
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.user_name == user_name).first()
            return user
        finally:
            db.close()

    except Exception as e:
        logger.warning(f"JWT verification failed: {e}")
        return None


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
