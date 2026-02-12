# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API Key service for managing user API keys.
"""

import hashlib
import logging
import secrets
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.api_key import KEY_TYPE_PERSONAL, APIKey

logger = logging.getLogger(__name__)


class APIKeyService:
    """Service for managing API keys."""

    DEFAULT_KEY_NAME = "Cloud Device Default Key"

    async def get_or_create_default_key(
        self,
        db: Session,
        user_id: int,
        user_name: str,
    ) -> tuple[APIKey, str]:
        """Get or create a default API key for the user.

        Used by cloud devices to get an authentication token.
        If the user has an active personal API key, return it along with a new
        temporary key (since we only store hashes and can't retrieve original keys).
        Otherwise, create a new default key.

        Args:
            db: Database session
            user_id: User ID
            user_name: User name (for logging)

        Returns:
            Tuple of (APIKey model instance, key string for authentication)
        """
        # Try to find an existing active personal key
        existing_key = (
            db.query(APIKey)
            .filter(
                APIKey.user_id == user_id,
                APIKey.key_type == KEY_TYPE_PERSONAL,
                APIKey.is_active == True,
            )
            .first()
        )

        if existing_key:
            logger.debug(f"Found existing API key for user {user_id}")
            # Since we only store the hash, we can't retrieve the original key.
            # For cloud devices, we need to create a temporary key.
            # In a production system, you might want to use a different approach
            # like storing encrypted keys or using a key derivation method.
            pass  # Fall through to create a new key

        # Create a new default key
        logger.info(f"Creating default API key for user {user_id}")

        # Generate key: wg-{32 random chars}
        random_part = secrets.token_urlsafe(32)
        full_key = f"wg-{random_part}"

        # Hash the key for storage
        key_hash = hashlib.sha256(full_key.encode()).hexdigest()

        # Create prefix for display (first 8 chars after "wg-")
        key_prefix = f"wg-{random_part[:8]}..."

        # Create the API key record
        api_key = APIKey(
            user_id=user_id,
            key_hash=key_hash,
            key_prefix=key_prefix,
            name=self.DEFAULT_KEY_NAME,
            key_type=KEY_TYPE_PERSONAL,
            description="Auto-created for cloud device authentication",
            expires_at=datetime(9999, 12, 31, 23, 59, 59),  # Never expires
        )

        db.add(api_key)
        db.commit()
        db.refresh(api_key)

        logger.info(f"Created default API key for user {user_id}: {key_prefix}")
        return api_key, full_key


# Singleton instance
api_key_service = APIKeyService()
