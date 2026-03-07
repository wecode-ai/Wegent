# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feishu user resolver."""

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.user import User

logger = logging.getLogger(__name__)

USER_MAPPING_MODE_SELECT_USER = "select_user"
USER_MAPPING_MODE_STAFF_ID = "staff_id"
USER_MAPPING_MODE_EMAIL = "email"


class FeishuUserResolver:
    """Resolves Feishu users to Wegent users."""

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
        feishu_open_id: str,
        feishu_name: Optional[str] = None,
        feishu_staff_id: Optional[str] = None,
    ) -> Optional[User]:
        if self.user_mapping_mode == USER_MAPPING_MODE_SELECT_USER:
            target_user_id = self.user_mapping_config.get("target_user_id")
            if not target_user_id:
                logger.warning("[FeishuUserResolver] target_user_id is not configured")
                return None

            return (
                self.db.query(User)
                .filter(User.id == target_user_id, User.is_active == True)
                .first()
            )

        if self.user_mapping_mode == USER_MAPPING_MODE_STAFF_ID and feishu_staff_id:
            return (
                self.db.query(User)
                .filter(User.user_name == feishu_staff_id, User.is_active == True)
                .first()
            )

        if self.user_mapping_mode == USER_MAPPING_MODE_EMAIL and feishu_staff_id:
            return (
                self.db.query(User)
                .filter(
                    User.email == f"{feishu_staff_id}@feishu.cn",
                    User.is_active == True,
                )
                .first()
            )

        logger.warning(
            "[FeishuUserResolver] Cannot resolve user: open_id=%s, name=%s, staff_id=%s",
            feishu_open_id,
            feishu_name,
            feishu_staff_id,
        )
        return None
