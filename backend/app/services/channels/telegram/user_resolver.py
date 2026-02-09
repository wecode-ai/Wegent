# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram User Resolver.

This module provides functionality to resolve Telegram users to Wegent users.
Supports select_user mode where all Telegram users are mapped to a specific
Wegent user.
"""

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.user import User

logger = logging.getLogger(__name__)

# User mapping modes
USER_MAPPING_MODE_SELECT_USER = "select_user"  # Map all users to a specific user
USER_MAPPING_MODE_USERNAME = "staff_id"  # Match by username (uses staff_id key)
USER_MAPPING_MODE_EMAIL = "email"  # Match user by email


class TelegramUserResolver:
    """
    Resolves Telegram users to Wegent users.

    This class handles the mapping between Telegram user identifiers
    and Wegent user accounts. Currently supports select_user mode
    where all Telegram users are mapped to a configured target user.
    """

    def __init__(
        self,
        db: Session,
        user_mapping_mode: Optional[str] = None,
        user_mapping_config: Optional[dict] = None,
    ):
        """
        Initialize the resolver.

        Args:
            db: Database session
            user_mapping_mode: User mapping mode (select_user, staff_id, email)
            user_mapping_config: Additional config for user mapping
        """
        self.db = db
        self.user_mapping_mode = user_mapping_mode or USER_MAPPING_MODE_SELECT_USER
        self.user_mapping_config = user_mapping_config or {}

    async def resolve_user(
        self,
        telegram_user_id: int,
        telegram_username: Optional[str] = None,
        telegram_first_name: Optional[str] = None,
        telegram_last_name: Optional[str] = None,
    ) -> Optional[User]:
        """
        Resolve a Telegram user to a Wegent user.

        Resolution logic:
        1. If mode is select_user, return the configured target user
        2. If mode is username (staff_id), try to match by Telegram username
        3. If mode is email, try to match by email (username@telegram.org)

        Args:
            telegram_user_id: Telegram user ID
            telegram_username: Telegram username (optional, without @)
            telegram_first_name: User's first name (optional)
            telegram_last_name: User's last name (optional)

        Returns:
            User object if found, None otherwise
        """
        # Handle select_user mode - return configured target user
        if self.user_mapping_mode == USER_MAPPING_MODE_SELECT_USER:
            target_user_id = self.user_mapping_config.get("target_user_id")
            if target_user_id:
                user = (
                    self.db.query(User)
                    .filter(
                        User.id == target_user_id,
                        User.is_active == True,
                    )
                    .first()
                )
                if user:
                    logger.info(
                        "[TelegramUserResolver] select_user mode: telegram_user_id=%s -> "
                        "target_user_id=%d",
                        telegram_user_id,
                        target_user_id,
                    )
                    return user
                else:
                    logger.warning(
                        "[TelegramUserResolver] select_user mode: target user not found, "
                        "target_user_id=%d",
                        target_user_id,
                    )
            else:
                logger.warning(
                    "[TelegramUserResolver] select_user mode: no target_user_id configured"
                )
            return None

        # Handle username mode - match by Telegram username
        if self.user_mapping_mode == USER_MAPPING_MODE_USERNAME and telegram_username:
            user = (
                self.db.query(User)
                .filter(
                    User.user_name == telegram_username,
                    User.is_active == True,
                )
                .first()
            )
            if user:
                logger.info(
                    "[TelegramUserResolver] username mode: telegram_username=%s -> "
                    "user_id=%d",
                    telegram_username,
                    user.id,
                )
                return user
            else:
                logger.warning(
                    "[TelegramUserResolver] username mode: user not found by "
                    "username=%s",
                    telegram_username,
                )
            return None

        # Handle email mode - construct email from username
        if self.user_mapping_mode == USER_MAPPING_MODE_EMAIL and telegram_username:
            email = f"{telegram_username}@telegram.org"
            user = (
                self.db.query(User)
                .filter(
                    User.email == email,
                    User.is_active == True,
                )
                .first()
            )
            if user:
                logger.info(
                    "[TelegramUserResolver] email mode: telegram_username=%s -> "
                    "email=%s -> user_id=%d",
                    telegram_username,
                    email,
                    user.id,
                )
                return user
            else:
                logger.warning(
                    "[TelegramUserResolver] email mode: user not found by email=%s",
                    email,
                )
            return None

        logger.warning(
            "[TelegramUserResolver] Cannot resolve user: mode=%s, "
            "telegram_user_id=%s, telegram_username=%s",
            self.user_mapping_mode,
            telegram_user_id,
            telegram_username,
        )
        return None
