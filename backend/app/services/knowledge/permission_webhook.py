# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Webhook notification functions for knowledge base permission events.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from app.services.webhook_notification import Notification, webhook_notification_service

logger = logging.getLogger(__name__)


def _get_db_session(db_url: str) -> Session:
    """Create a new database session for background tasks."""
    engine = create_engine(db_url.replace("+asyncmy", "+pymysql"))
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    return SessionLocal()


def send_permission_request_notification(
    db_url: str,
    permission_id: int,
    kb_id: int,
    applicant_id: int,
    applicant_name: str,
    applicant_email: Optional[str],
    permission_level: str,
) -> bool:
    """
    Send webhook notification for permission request to KB owner.

    Args:
        db_url: Database URL for creating session
        permission_id: Permission record ID
        kb_id: Knowledge base ID
        applicant_id: Applicant user ID
        applicant_name: Applicant username
        applicant_email: Applicant email
        permission_level: Requested permission level

    Returns:
        True if notification sent successfully
    """
    if not settings.WEBHOOK_ENABLED:
        logger.info("Webhook notifications are disabled")
        return False

    db = None
    try:
        db = _get_db_session(db_url)

        # Get KB info
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
            )
            .first()
        )

        if not kb:
            logger.warning(f"KB {kb_id} not found for permission notification")
            return False

        spec = kb.json.get("spec", {})
        kb_name = spec.get("name", "")
        kb_description = spec.get("description", "")

        # Get KB owner info
        owner = db.query(User).filter(User.id == kb.user_id).first()
        owner_name = owner.user_name if owner else f"User {kb.user_id}"

        # Build action URL
        action_url = f"{settings.FRONTEND_URL}/knowledge/{kb_id}?tab=permissions"

        # Build notification
        now = datetime.now()
        notification = Notification(
            user_name=owner_name,
            event="kb_permission_request",
            id=str(permission_id),
            start_time=now.isoformat(),
            end_time=now.isoformat(),
            description=f"User {applicant_name} ({applicant_email or 'no email'}) requested {permission_level} permission for knowledge base '{kb_name}'",
            status="pending",
            detail_url=action_url,
        )

        # Send notification synchronously (we're already in a background task)
        return webhook_notification_service.send_notification_sync(notification)

    except Exception as e:
        logger.exception(f"Error sending permission request notification: {e}")
        return False
    finally:
        if db:
            db.close()


def send_permission_review_notification(
    db_url: str,
    permission_id: int,
    kb_id: int,
    applicant_id: int,
    permission_level: str,
    status: str,
) -> bool:
    """
    Send webhook notification for permission review result to applicant.

    Args:
        db_url: Database URL for creating session
        permission_id: Permission record ID
        kb_id: Knowledge base ID
        applicant_id: Applicant user ID
        permission_level: Permission level
        status: Review status (approved/rejected)

    Returns:
        True if notification sent successfully
    """
    if not settings.WEBHOOK_ENABLED:
        logger.info("Webhook notifications are disabled")
        return False

    db = None
    try:
        db = _get_db_session(db_url)

        # Get KB info
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
            )
            .first()
        )

        if not kb:
            logger.warning(f"KB {kb_id} not found for permission notification")
            return False

        spec = kb.json.get("spec", {})
        kb_name = spec.get("name", "")

        # Get applicant info
        applicant = db.query(User).filter(User.id == applicant_id).first()
        applicant_name = applicant.user_name if applicant else f"User {applicant_id}"

        # Build action URL
        action_url = f"{settings.FRONTEND_URL}/knowledge/{kb_id}"

        # Build notification
        now = datetime.now()
        status_text = "approved" if status == "approved" else "rejected"
        description = (
            f"Your {permission_level} permission request for knowledge base '{kb_name}' has been {status_text}"
        )

        notification = Notification(
            user_name=applicant_name,
            event="kb_permission_reviewed",
            id=str(permission_id),
            start_time=now.isoformat(),
            end_time=now.isoformat(),
            description=description,
            status=status,
            detail_url=action_url,
        )

        # Send notification synchronously
        return webhook_notification_service.send_notification_sync(notification)

    except Exception as e:
        logger.exception(f"Error sending permission review notification: {e}")
        return False
    finally:
        if db:
            db.close()
