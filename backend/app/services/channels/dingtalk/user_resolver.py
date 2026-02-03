# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk User Resolver.

This module provides functionality to resolve DingTalk users to Wegent users.
It uses the pluggable user mapper interface for enterprise user resolution.
If no mapper is registered or mapping fails, falls back to staff_id (employee ID) as username.
"""

import json
import logging
import uuid
from typing import Optional

from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.user import User
from app.services.channels.dingtalk.user_mapping import get_user_mapper
from app.services.k_batch import apply_default_resources_sync

logger = logging.getLogger(__name__)


# User mapping modes
USER_MAPPING_MODE_STAFF_ID = "staff_id"  # Use staff_id as username (original behavior)
USER_MAPPING_MODE_EMAIL = "email"  # Match user by email
USER_MAPPING_MODE_SELECT_USER = "select_user"  # Map all users to a specific user


class DingTalkUserResolver:
    """
    Resolves DingTalk users to Wegent users.

    This class handles the mapping between DingTalk user identifiers
    and Wegent user accounts by:
    1. Using channel-configured user mapping mode (select_user, email, staff_id)
    2. Using the registered user mapper (for enterprise deployments)
    3. Falling back to staff_id (employee ID) as username
    4. Auto-creating users if not found
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
            user_mapping_mode: User mapping mode (staff_id, email, select_user)
            user_mapping_config: Additional config for user mapping (e.g., target_user_id)
        """
        self.db = db
        self.user_mapping_mode = user_mapping_mode or USER_MAPPING_MODE_STAFF_ID
        self.user_mapping_config = user_mapping_config or {}

    async def resolve_user(
        self,
        sender_id: str,
        sender_nick: Optional[str] = None,
        sender_staff_id: Optional[str] = None,
    ) -> Optional[User]:
        """
        Resolve a DingTalk user to a Wegent user.

        Resolution logic:
        1. If mode is select_user, return the configured target user
        2. If mode is email, try to match by email from user mapper
        3. Try user mapper (for enterprise user directory integration)
        4. Fall back to staff_id (employee ID) as username
        5. Auto-create user if not found

        Args:
            sender_id: DingTalk user ID (userId)
            sender_nick: User's nickname (optional)
            sender_staff_id: Employee staff ID (optional)

        Returns:
            User object if found/created, None otherwise
        """
        # Step 0: Handle select_user mode - return configured target user
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
                        "[DingTalkUserResolver] select_user mode: sender_id=%s -> target_user_id=%d",
                        sender_id,
                        target_user_id,
                    )
                    return user
                else:
                    logger.warning(
                        "[DingTalkUserResolver] select_user mode: target user not found, "
                        "target_user_id=%d",
                        target_user_id,
                    )
            else:
                logger.warning(
                    "[DingTalkUserResolver] select_user mode: no target_user_id configured"
                )
            # Fall through to default behavior if select_user fails

        user_name: Optional[str] = None
        email: Optional[str] = None

        # Step 1: Try user mapper for enterprise user resolution
        if sender_staff_id:
            mapper = get_user_mapper()
            try:
                mapped_info = await mapper.map_user(
                    staff_id=sender_staff_id,
                    sender_id=sender_id,
                    sender_nick=sender_nick,
                )
                if mapped_info:
                    user_name = mapped_info.user_name
                    email = mapped_info.email
                    logger.debug(
                        "[DingTalkUserResolver] Mapper resolved: staff_id=%s -> user_name=%s",
                        sender_staff_id,
                        user_name,
                    )
            except Exception as e:
                logger.warning(
                    "[DingTalkUserResolver] User mapper failed: staff_id=%s, error=%s",
                    sender_staff_id,
                    e,
                )

        # Step 1.5: Handle email mode - try to find user by email
        if self.user_mapping_mode == USER_MAPPING_MODE_EMAIL and email:
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
                    "[DingTalkUserResolver] email mode: sender_id=%s -> email=%s -> user_id=%d",
                    sender_id,
                    email,
                    user.id,
                )
                return user
            else:
                logger.warning(
                    "[DingTalkUserResolver] email mode: user not found by email=%s",
                    email,
                )
            # Fall through to default behavior if email mode fails

        # Step 2: Fall back to staff_id (employee ID) as username
        if not user_name and sender_staff_id:
            user_name = sender_staff_id
            logger.debug(
                "[DingTalkUserResolver] Using staff_id as username: %s",
                sender_staff_id,
            )

        if not user_name:
            logger.warning(
                "[DingTalkUserResolver] Cannot resolve user: no staff_id mapping and no staff_id, "
                "sender_id=%s",
                sender_id,
            )
            return None

        # Step 3: Find user by username
        user = (
            self.db.query(User)
            .filter(
                User.user_name == user_name,
                User.is_active == True,
            )
            .first()
        )

        if user:
            logger.info(
                "[DingTalkUserResolver] Found user: sender_id=%s -> user_name=%s -> user_id=%d",
                sender_id,
                user_name,
                user.id,
            )
            return user

        # Step 4: Auto-create user
        logger.info(
            "[DingTalkUserResolver] User not found, creating new user: user_name=%s",
            user_name,
        )
        return self._create_user(user_name, email)

    def _create_user(
        self, user_name: str, email: Optional[str] = None
    ) -> Optional[User]:
        """
        Create a new user from DingTalk information.

        Args:
            user_name: Username
            email: Email address (optional, defaults to user_name@dingtalk.com)

        Returns:
            Created User object or None if failed
        """
        # Use default email if not provided
        if not email:
            email = f"{user_name}@dingtalk.com"

        try:
            new_user = User(
                user_name=user_name,
                email=email,
                password_hash=get_password_hash(str(uuid.uuid4())),
                git_info=[],
                is_active=True,
                preferences=json.dumps({}),
                auth_source="dingtalk",
            )
            self.db.add(new_user)
            self.db.commit()
            self.db.refresh(new_user)

            logger.info(
                "[DingTalkUserResolver] Created new user: user_id=%d, user_name=%s, email=%s",
                new_user.id,
                user_name,
                email,
            )

            # Apply default resources for new user
            try:
                apply_default_resources_sync(new_user.id)
                logger.info(
                    "[DingTalkUserResolver] Applied default resources for user %d",
                    new_user.id,
                )
            except Exception as e:
                logger.warning(
                    "[DingTalkUserResolver] Failed to apply default resources for user %d: %s",
                    new_user.id,
                    e,
                )

            return new_user

        except Exception as e:
            logger.error(
                "[DingTalkUserResolver] Failed to create user: user_name=%s, error=%s",
                user_name,
                e,
            )
            self.db.rollback()
            return None
