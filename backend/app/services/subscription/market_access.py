# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for market subscription access control."""

from typing import Iterable, List, Optional

from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.subscription import SubscriptionVisibility


def normalize_market_whitelist_user_ids(user_ids: Optional[Iterable[int]]) -> List[int]:
    """Normalize market whitelist IDs by filtering invalid values and de-duplicating."""
    if not user_ids:
        return []

    normalized: List[int] = []
    seen: set[int] = set()
    for user_id in user_ids:
        if not isinstance(user_id, int):
            continue
        if user_id <= 0 or user_id in seen:
            continue
        seen.add(user_id)
        normalized.append(user_id)

    return normalized


def filter_existing_market_whitelist_user_ids(
    db: Session, user_ids: Optional[Iterable[int]]
) -> List[int]:
    """Filter whitelist IDs to active users that actually exist."""
    normalized_ids = normalize_market_whitelist_user_ids(user_ids)
    if not normalized_ids:
        return []

    existing_user_ids = {
        row[0]
        for row in db.query(User.id).filter(
            User.id.in_(normalized_ids),
            User.is_active == True,
        )
    }
    return [user_id for user_id in normalized_ids if user_id in existing_user_ids]


def get_market_whitelist_user_ids_from_internal(internal: dict) -> List[int]:
    """Read and normalize market whitelist user IDs from subscription internal JSON."""
    return normalize_market_whitelist_user_ids(
        internal.get("market_whitelist_user_ids", [])
    )


def can_view_market_subscription(
    *,
    visibility: SubscriptionVisibility,
    owner_user_id: int,
    current_user_id: int,
    whitelist_user_ids: List[int],
) -> bool:
    """Check if current user can discover/detail/rent a market subscription."""
    if visibility != SubscriptionVisibility.MARKET:
        return False

    if current_user_id == owner_user_id:
        return True

    if not whitelist_user_ids:
        return True

    return current_user_id in whitelist_user_ids
