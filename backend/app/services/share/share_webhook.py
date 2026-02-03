# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Webhook notification functions for unified resource sharing events.

Provides notification services for share requests and reviews across
all resource types (Team, Task, KnowledgeBase).
"""

import logging
from datetime import datetime
from functools import lru_cache
from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.services.webhook_notification import Notification, webhook_notification_service

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _get_engine(db_url: str) -> Engine:
    """Get or create a cached database engine."""
    return create_engine(db_url.replace("+asyncmy", "+pymysql"))


def _get_db_session(db_url: str) -> Session:
    """Create a new database session for background tasks."""
    engine = _get_engine(db_url)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    return SessionLocal()


def _get_resource_info(
    db: Session, resource_type: str, resource_id: int
) -> tuple[Optional[str], Optional[int]]:
    """
    Get resource name and owner ID for a given resource.

    Args:
        db: Database session
        resource_type: Resource type (Team, Task, KnowledgeBase)
        resource_id: Resource ID

    Returns:
        Tuple of (resource_name, owner_user_id) or (None, None) if not found
    """
    if resource_type == ResourceType.KNOWLEDGE_BASE.value:
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "KnowledgeBase",
            )
            .first()
        )
        if kb:
            spec = kb.json.get("spec", {})
            return spec.get("name", ""), kb.user_id
    elif resource_type == ResourceType.TEAM.value:
        team = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "Team",
            )
            .first()
        )
        if team:
            spec = team.json.get("spec", {})
            return spec.get("name", team.name), team.user_id
    elif resource_type == ResourceType.TASK.value:
        task = db.query(TaskResource).filter(TaskResource.id == resource_id).first()
        if task:
            return task.name, task.user_id

    return None, None


def _get_frontend_url(resource_type: str, resource_id: int) -> str:
    """
    Get frontend URL for a resource.

    Args:
        resource_type: Resource type
        resource_id: Resource ID

    Returns:
        Frontend URL for the resource
    """
    base_url = settings.FRONTEND_URL

    if resource_type == ResourceType.KNOWLEDGE_BASE.value:
        return f"{base_url}/knowledge/{resource_id}?tab=permissions"
    elif resource_type == ResourceType.TEAM.value:
        return f"{base_url}/agents/{resource_id}/settings"
    elif resource_type == ResourceType.TASK.value:
        return f"{base_url}/chat/{resource_id}"

    return base_url


def send_share_request_notification(
    db_url: str,
    resource_type: str,
    resource_id: int,
    member_id: int,
    applicant_name: str,
    applicant_email: Optional[str],
    permission_level: str,
) -> bool:
    """
    Send webhook notification for share request to resource owner.

    Args:
        db_url: Database URL for creating session
        resource_type: Resource type (Team, Task, KnowledgeBase)
        resource_id: Resource ID
        member_id: ResourceMember record ID
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

        # Get resource info
        resource_name, owner_id = _get_resource_info(db, resource_type, resource_id)

        if not resource_name or not owner_id:
            logger.warning(
                f"Resource {resource_type}/{resource_id} not found for share notification"
            )
            return False

        # Get owner info
        owner = db.query(User).filter(User.id == owner_id).first()
        owner_name = owner.user_name if owner else f"User {owner_id}"

        # Build action URL
        action_url = _get_frontend_url(resource_type, resource_id)

        # Build notification
        now = datetime.now()

        # Map resource type to friendly name
        resource_type_name = {
            ResourceType.KNOWLEDGE_BASE.value: "knowledge base",
            ResourceType.TEAM.value: "agent",
            ResourceType.TASK.value: "task",
        }.get(resource_type, "resource")

        # Mask email unless PII is explicitly allowed
        email_display = (
            applicant_email if settings.ALLOW_PII_IN_WEBHOOKS else "***@***.***"
        )
        notification = Notification(
            user_name=owner_name,
            event=f"{resource_type.lower()}_share_request",
            id=str(member_id),
            start_time=now.isoformat(),
            end_time=now.isoformat(),
            description=(
                f"User {applicant_name} ({email_display}) "
                f"requested {permission_level} permission for {resource_type_name} '{resource_name}'"
            ),
            status="pending",
            detail_url=action_url,
        )

        # Send notification synchronously (we're already in a background task)
        return webhook_notification_service.send_notification_sync(notification)

    except Exception as e:
        logger.exception(f"Error sending share request notification: {e}")
        return False
    finally:
        if db:
            db.close()


def send_share_review_notification(
    db_url: str,
    resource_type: str,
    resource_id: int,
    member_id: int,
    applicant_id: int,
    permission_level: str,
    status: str,
) -> bool:
    """
    Send webhook notification for share review result to applicant.

    Args:
        db_url: Database URL for creating session
        resource_type: Resource type (Team, Task, KnowledgeBase)
        resource_id: Resource ID
        member_id: ResourceMember record ID
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

        # Get resource info
        resource_name, _ = _get_resource_info(db, resource_type, resource_id)

        if not resource_name:
            logger.warning(
                f"Resource {resource_type}/{resource_id} not found for share notification"
            )
            return False

        # Get applicant info
        applicant = db.query(User).filter(User.id == applicant_id).first()
        applicant_name = applicant.user_name if applicant else f"User {applicant_id}"

        # Build action URL
        action_url = _get_frontend_url(resource_type, resource_id)

        # Build notification
        now = datetime.now()
        status_text = "approved" if status == "approved" else "rejected"

        # Map resource type to friendly name
        resource_type_name = {
            ResourceType.KNOWLEDGE_BASE.value: "knowledge base",
            ResourceType.TEAM.value: "agent",
            ResourceType.TASK.value: "task",
        }.get(resource_type, "resource")

        description = (
            f"Your {permission_level} permission request for "
            f"{resource_type_name} '{resource_name}' has been {status_text}"
        )

        notification = Notification(
            user_name=applicant_name,
            event=f"{resource_type.lower()}_share_reviewed",
            id=str(member_id),
            start_time=now.isoformat(),
            end_time=now.isoformat(),
            description=description,
            status=status,
            detail_url=action_url,
        )

        # Send notification synchronously
        return webhook_notification_service.send_notification_sync(notification)

    except Exception as e:
        logger.exception(f"Error sending share review notification: {e}")
        return False
    finally:
        if db:
            db.close()
