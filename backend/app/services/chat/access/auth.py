# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication utilities for Chat Service.

This module provides token verification for WebSocket connections,
supporting both JWT tokens and API Keys.
"""

import hashlib
import logging
from datetime import datetime
from typing import Optional, Tuple

from jose import jwt
from jose.exceptions import ExpiredSignatureError

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.api_key import APIKey
from app.models.user import User

logger = logging.getLogger(__name__)

# API Key prefix constant
API_KEY_PREFIX = "wg-"


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


def is_api_key(token: str) -> bool:
    """
    Check if the token is an API Key.

    API Keys have a "wg-" prefix.

    Args:
        token: Token string

    Returns:
        True if token is an API Key, False otherwise
    """
    return token.startswith(API_KEY_PREFIX) if token else False


def verify_api_key_for_websocket(api_key: str) -> Tuple[Optional[User], Optional[int]]:
    """
    Verify API Key and return user with optional expiry timestamp.

    This function validates the API Key for WebSocket authentication.
    It checks the key hash, active status, and expiration.

    Args:
        api_key: API Key string starting with "wg-"

    Returns:
        Tuple of (User object if valid, expiry timestamp or None for never expires)
        Returns (None, None) if validation fails
    """
    if not api_key or not api_key.startswith(API_KEY_PREFIX):
        logger.warning("API Key verification failed: invalid prefix")
        return None, None

    db = SessionLocal()
    try:
        # Calculate SHA256 hash of the API key
        key_hash = hashlib.sha256(api_key.encode()).hexdigest()

        # Query API Key record
        api_key_record = (
            db.query(APIKey)
            .filter(
                APIKey.key_hash == key_hash,
                APIKey.is_active == True,
            )
            .first()
        )

        if not api_key_record:
            logger.warning("API Key verification failed: key not found or inactive")
            return None, None

        # Check expiration
        if api_key_record.expires_at < datetime.utcnow():
            logger.warning(
                f"API Key verification failed: key expired at {api_key_record.expires_at}"
            )
            return None, None

        # Update last_used_at
        api_key_record.last_used_at = datetime.utcnow()
        db.commit()

        # Get associated user
        user = db.query(User).filter(User.id == api_key_record.user_id).first()
        if not user:
            logger.warning(
                f"API Key verification failed: user not found for user_id={api_key_record.user_id}"
            )
            return None, None

        if not user.is_active:
            logger.warning(
                f"API Key verification failed: user is inactive user_id={user.id}"
            )
            return None, None

        # Calculate expiry timestamp
        # For API Keys with far-future expiry (9999-12-31), treat as never expires (None)
        expiry_timestamp = None
        if api_key_record.expires_at.year < 9999:
            expiry_timestamp = int(api_key_record.expires_at.timestamp())

        logger.info(
            f"API Key verification successful: user_id={user.id}, "
            f"key_name={api_key_record.name}, expires_at={api_key_record.expires_at}"
        )
        return user, expiry_timestamp

    except Exception as e:
        logger.exception(f"API Key verification error: {e}")
        return None, None
    finally:
        db.close()


def verify_websocket_token(token: str) -> Tuple[Optional[User], Optional[int], str]:
    """
    Unified WebSocket token verification entry point.

    Automatically identifies token type and calls the appropriate verification method:
    - "wg-" prefix → API Key verification
    - Otherwise → JWT token verification

    Args:
        token: Token string (JWT or API Key)

    Returns:
        Tuple of (User object if valid, expiry timestamp, auth_type)
        - auth_type is "api_key" or "jwt"
        - expiry timestamp is None for never-expiring API Keys
        Returns (None, None, "") if validation fails
    """
    if not token:
        logger.warning("WebSocket token verification failed: empty token")
        return None, None, ""

    if is_api_key(token):
        # API Key authentication
        user, expiry = verify_api_key_for_websocket(token)
        return user, expiry, "api_key" if user else ""
    else:
        # JWT token authentication
        user = verify_jwt_token(token)
        if user:
            expiry = get_token_expiry(token)
            return user, expiry, "jwt"
        return None, None, ""
