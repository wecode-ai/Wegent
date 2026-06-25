# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo user resolver."""

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.user import User

logger = logging.getLogger(__name__)

USER_MAPPING_MODE_SELECT_USER = "select_user"
USER_MAPPING_MODE_WEIBO_USER_ID = "staff_id"
USER_MAPPING_MODE_EMAIL = "email"


class WeiboUserResolver:
    """Resolve Weibo Open IM user IDs to Wegent users."""

    def __init__(
        self,
        db: Session,
        user_mapping_mode: Optional[str] = None,
        user_mapping_config: Optional[dict] = None,
    ):
        self.db = db
        self.user_mapping_mode = user_mapping_mode or USER_MAPPING_MODE_SELECT_USER
        self.user_mapping_config = user_mapping_config or {}

    async def resolve_user(
        self,
        *,
        weibo_user_id: str,
        weibo_email: Optional[str] = None,
    ) -> Optional[User]:
        if self.user_mapping_mode == USER_MAPPING_MODE_SELECT_USER:
            return self._resolve_selected_user(weibo_user_id)

        if self.user_mapping_mode == USER_MAPPING_MODE_WEIBO_USER_ID:
            return self._resolve_by_username(str(weibo_user_id), "weibo_user_id")

        if self.user_mapping_mode == USER_MAPPING_MODE_EMAIL and weibo_email:
            return self._resolve_by_email(weibo_email)

        logger.warning(
            "[WeiboUserResolver] Cannot resolve user: mode=%s, weibo_user_id=%s, "
            "weibo_email=%s",
            self.user_mapping_mode,
            weibo_user_id,
            weibo_email,
        )
        return None

    def _resolve_selected_user(self, weibo_user_id: str) -> Optional[User]:
        target_user_id = self.user_mapping_config.get("target_user_id")
        if not target_user_id:
            logger.warning(
                "[WeiboUserResolver] select_user mode: no target_user_id configured"
            )
            return None

        user = (
            self.db.query(User)
            .filter(User.id == target_user_id, User.is_active.is_(True))
            .first()
        )
        if user:
            logger.info(
                "[WeiboUserResolver] select_user mode: weibo_user_id=%s -> "
                "target_user_id=%s",
                weibo_user_id,
                target_user_id,
            )
        return user

    def _resolve_by_username(
        self,
        username: str,
        source: str,
    ) -> Optional[User]:
        user = (
            self.db.query(User)
            .filter(User.user_name == username, User.is_active.is_(True))
            .first()
        )
        if user:
            logger.info(
                "[WeiboUserResolver] %s mode: username=%s -> user_id=%d",
                source,
                username,
                user.id,
            )
        return user

    def _resolve_by_email(self, email: str) -> Optional[User]:
        user = (
            self.db.query(User)
            .filter(User.email == email, User.is_active.is_(True))
            .first()
        )
        if user:
            logger.info(
                "[WeiboUserResolver] email mode: email=%s -> user_id=%d",
                email,
                user.id,
            )
        return user
