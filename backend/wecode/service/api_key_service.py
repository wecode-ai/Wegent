# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API Key service for cloud devices.

This module provides API key management specifically for cloud device operations.
"""

import hashlib
import secrets
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from app.models.api_key import KEY_TYPE_PERSONAL, APIKey


def create_api_key_for_cloud_device(
    db: Session,
    user_id: int,
    user_name: str,
) -> Tuple[APIKey, str]:
    """Create a new API key for cloud device authentication.

    This function creates a new personal API key specifically for use with
    cloud devices. The full key is returned and must be saved by the caller
    as it cannot be retrieved later.

    Args:
        db: Database session
        user_id: User ID
        user_name: User name for generating key name

    Returns:
        Tuple of (APIKey object, full key string)
    """
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
        name=f"{user_name}-cloud-device",
        key_type=KEY_TYPE_PERSONAL,
        description="Auto-generated for cloud device",
    )

    db.add(api_key)
    db.commit()
    db.refresh(api_key)

    return api_key, full_key
