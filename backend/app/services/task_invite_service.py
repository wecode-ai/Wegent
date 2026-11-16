# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for task invite link functionality."""

import logging
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

import app.stores.tasks as task_stores
from app.core.config import settings
from app.models.share_link import ResourceType, ShareLink
from app.services.share.token_access import (
    hash_share_token,
    require_share_link_access,
    share_token_lookup,
)

logger = logging.getLogger(__name__)


class TaskInviteService:
    """Service for generating and validating group chat invite links."""

    def generate_invite_token(
        self, db: Session, task_id: int, inviter_id: int, expires_hours: int = 0
    ) -> str:
        """
        Generate and persist a group chat invite token.
        """
        if expires_hours == 0:
            expire_time = datetime.utcnow() + timedelta(days=3650)
        else:
            expire_time = datetime.utcnow() + timedelta(hours=expires_hours)

        token = secrets.token_urlsafe(32)
        db.add(
            ShareLink(
                resource_type=ResourceType.TASK_INVITE.value,
                resource_id=task_id,
                share_token=token,
                token_hash=self._hash_share_token(token),
                token_version=ShareLink.OPAQUE_TOKEN_VERSION,
                require_approval=False,
                default_role="Reporter",
                expires_at=expire_time,
                created_by_user_id=inviter_id,
                is_active=True,
            )
        )
        db.commit()
        return token

    def _hash_share_token(self, token: str) -> str:
        """Return the SHA-256 digest used for token lookup."""
        return hash_share_token(token)

    def decode_invite_token(
        self, db: Session, token: str, viewer_id: Optional[int] = None
    ) -> Optional[dict]:
        """
        Resolve a group chat invite token to its active share record.

        Returns: {"task_id": int, "inviter_id": int, "expires_at": datetime, "is_expired": bool}
        """
        invite = (
            db.query(ShareLink)
            .filter(
                share_token_lookup(token),
                ShareLink.resource_type == ResourceType.TASK_INVITE.value,
                ShareLink.is_active.is_(True),
            )
            .first()
        )
        if not invite:
            logger.info("Invalid or inactive invite token")
            return None

        require_share_link_access(
            db,
            invite,
            viewer_id,
            lambda uid: task_stores.task_access_store.is_member(
                db, task_id=invite.resource_id, user_id=uid
            ),
        )
        return {
            "task_id": invite.resource_id,
            "inviter_id": invite.created_by_user_id,
            "expires_at": invite.expires_at,
            "is_expired": invite.is_expired,
        }

    def generate_invite_url(self, token: str) -> str:
        """Generate the full invite URL"""
        base_url = settings.TASK_SHARE_BASE_URL
        return f"{base_url}/chat?invite={token}"


task_invite_service = TaskInviteService()
