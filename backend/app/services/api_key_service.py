# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API key helpers for system-generated device credentials."""

import hashlib
import secrets
from typing import Tuple

from sqlalchemy.orm import Session

from app.models.api_key import KEY_TYPE_PERSONAL, APIKey


def create_api_key_for_remote_device(
    db: Session,
    user_id: int,
    user_name: str,
) -> Tuple[APIKey, str]:
    """Create a new personal API key for remote Docker device authentication."""
    random_part = secrets.token_urlsafe(32)
    full_key = f"wg-{random_part}"
    api_key = APIKey(
        user_id=user_id,
        key_hash=hashlib.sha256(full_key.encode()).hexdigest(),
        key_prefix=f"wg-{random_part[:8]}...",
        name=f"{user_name}-remote-device",
        key_type=KEY_TYPE_PERSONAL,
        description="Auto-generated for remote Docker device",
    )

    db.add(api_key)
    db.commit()
    db.refresh(api_key)
    return api_key, full_key
