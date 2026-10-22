# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified authentication utilities for API Key and JWT Token verification.

This module provides common authentication functions that can be used across
different parts of the application (HTTP endpoints, WebSocket connections, etc.)
to support both JWT Token and API Key authentication methods.

API Key Format:
- Format: wg-{32 random characters}
- Storage: SHA256 hash stored in database
- Only personal API keys are supported for executor authentication
"""

import hashlib
import logging
from datetime import datetime
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from app.models.api_key import KEY_TYPE_PERSONAL, APIKey
from app.models.user import User

logger = logging.getLogger(__name__)

# API Key prefix used to identify API Key tokens
API_KEY_PREFIX = "wg-"


def is_api_key(token: str) -> bool:
    """
    Check if a token is an API Key based on its prefix.

    Args:
        token: Token string to check

    Returns:
        True if token starts with 'wg-', False otherwise
    """
    return token.startswith(API_KEY_PREFIX) if token else False


def find_valid_api_key(
    db: Session,
    api_key: str,
    *,
    key_type: str,
) -> Optional[APIKey]:
    """Find an active, unexpired key of the requested type without writing."""
    if not is_api_key(api_key):
        return None

    # Calculate SHA256 hash of the API key
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    # Query API key record
    api_key_record = (
        db.query(APIKey)
        .filter(
            APIKey.key_hash == key_hash,
            APIKey.key_type == key_type,
            APIKey.is_active == True,  # noqa: E712
        )
        .first()
    )

    if not api_key_record:
        return None

    # Check if API key is expired
    if api_key_record.expires_at < datetime.utcnow():
        logger.warning(
            f"[auth_utils] API key expired: name={api_key_record.name}, "
            f"expired_at={api_key_record.expires_at}"
        )
        return None

    return api_key_record


def verify_api_key(
    db: Session,
    api_key: str,
    *,
    update_last_used_at: bool = True,
) -> Optional[User]:
    """Verify a personal API key and return its active owner.

    Service keys are not supported for executor authentication. Set
    ``update_last_used_at=False`` for a read-only owner lookup.
    """
    api_key_record = find_valid_api_key(db, api_key, key_type=KEY_TYPE_PERSONAL)
    if not api_key_record:
        logger.warning("[auth_utils] Invalid, inactive, or expired personal API key")
        return None

    # Get the associated user
    user = db.query(User).filter(User.id == api_key_record.user_id).first()

    if not user:
        logger.warning(
            f"[auth_utils] User not found for API key: name={api_key_record.name}"
        )
        return None

    if not user.is_active:
        logger.warning(
            f"[auth_utils] User inactive for API key: name={api_key_record.name}, "
            f"user={user.user_name}"
        )
        return None

    if update_last_used_at:
        api_key_record.last_used_at = datetime.utcnow()
        db.commit()

    logger.debug(
        f"[auth_utils] API key verified: name={api_key_record.name}, "
        f"user={user.user_name}"
    )

    return user


def verify_jwt_token_with_db(db: Session, token: str) -> Optional[User]:
    """
    Verify JWT token and return user from the provided database session.

    This is a variant of verify_jwt_token that uses an external db session
    instead of creating its own.

    Args:
        db: Database session
        token: JWT token string

    Returns:
        User object if verification succeeds, None otherwise
    """
    from jose import jwt as jose_jwt
    from jose.exceptions import JWTError

    from app.core.config import settings
    from app.core.session_token import is_user_session_payload

    try:
        payload = jose_jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        if not is_user_session_payload(payload):
            logger.debug("[auth_utils] JWT is not a user session token")
            return None
        user_name = payload.get("sub")
        if not user_name:
            return None

        user = db.query(User).filter(User.user_name == user_name).first()
        if user and user.is_active:
            return user
        return None

    except JWTError as e:
        logger.debug(f"[auth_utils] JWT verification failed: {e}")
        return None
    except Exception as e:
        logger.warning(f"[auth_utils] JWT verification error: {e}")
        return None


def verify_token_flexible(
    db: Session,
    token: str,
) -> Tuple[Optional[User], str]:
    """
    Flexibly verify a token, supporting both JWT Token and API Key.

    Detection logic:
    - If token starts with 'wg-', treat as API Key
    - Otherwise, treat as JWT Token

    Args:
        db: Database session
        token: JWT Token or API Key string

    Returns:
        Tuple of (User, auth_type):
        - (User, "api_key") if API Key verification succeeds
        - (User, "jwt") if JWT Token verification succeeds
        - (None, "") if verification fails
    """
    if not token:
        return None, ""

    token = token.strip()

    # Check if it's an API Key
    if is_api_key(token):
        user = verify_api_key(db, token)
        if user:
            return user, "api_key"
        return None, ""

    # Otherwise, verify as JWT token
    user = verify_jwt_token_with_db(db, token)
    if user:
        return user, "jwt"

    return None, ""
