# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""JWT authentication utilities for Chat Service.

This module provides JWT token verification for WebSocket connections.
"""

import logging
from typing import Optional

from jose import jwt

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
