# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Notification service for knowledge base permission events.

Sends webhook notifications when permissions are granted, updated, or revoked.
"""

import logging
from datetime import datetime
from typing import Optional

from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from app.schemas.knowledge_notification import KnowledgeNotificationType
from app.services.webhook_notification import Notification, webhook_notification_service

logger = logging.getLogger(__name__)


async def send_knowledge_permission_notification(
    event_type: KnowledgeNotificationType,
    kb: Kind,
    target_user: User,
    permission_type: Optional[str] = None,
    applicant_user: Optional[User] = None,
    request_reason: Optional[str] = None,
    response_message: Optional[str] = None,
):
    """
    Send knowledge base permission notification via webhook.

    Args:
        event_type: Type of permission event
        kb: Knowledge base Kind object
        target_user: User who is affected by the permission change
        permission_type: Permission level (for granted/updated/approved events)
        applicant_user: User who submitted the request (for request submitted events)
        request_reason: Reason for the request (for request submitted events)
        response_message: Response message from approver (for approved/rejected events)
    """
    try:
        kb_name = kb.json.get("spec", {}).get("name", kb.name)

        # Build description based on event type
        if event_type == KnowledgeNotificationType.PERMISSION_GRANTED:
            description = (
                f"You have been granted '{permission_type}' access to knowledge base "
                f"'{kb_name}'"
            )
        elif event_type == KnowledgeNotificationType.PERMISSION_UPDATED:
            description = (
                f"Your access to knowledge base '{kb_name}' has been updated to "
                f"'{permission_type}'"
            )
        elif event_type == KnowledgeNotificationType.PERMISSION_REVOKED:
            description = f"Your access to knowledge base '{kb_name}' has been revoked"
        elif event_type == KnowledgeNotificationType.PERMISSION_REQUEST_SUBMITTED:
            # Notification to KB owner about new request
            applicant_name = applicant_user.user_name if applicant_user else "Unknown"
            reason_text = f" Reason: {request_reason}" if request_reason else ""
            description = (
                f"User '{applicant_name}' has requested access to your knowledge base "
                f"'{kb_name}'.{reason_text}"
            )
        elif event_type == KnowledgeNotificationType.PERMISSION_REQUEST_APPROVED:
            # Notification to applicant about approval
            response_text = f" Message: {response_message}" if response_message else ""
            description = (
                f"Your request for access to knowledge base '{kb_name}' has been approved. "
                f"You now have '{permission_type}' permission.{response_text}"
            )
        elif event_type == KnowledgeNotificationType.PERMISSION_REQUEST_REJECTED:
            # Notification to applicant about rejection
            response_text = f" Reason: {response_message}" if response_message else ""
            description = f"Your request for access to knowledge base '{kb_name}' has been rejected.{response_text}"
        else:
            description = f"Permission change for knowledge base '{kb_name}': {permission_type or 'revoked'}"

        # Determine detail URL based on event type
        if event_type == KnowledgeNotificationType.PERMISSION_REQUEST_SUBMITTED:
            # Link to approval page for KB owner
            detail_url = f"{settings.FRONTEND_URL}/knowledge/{kb.id}/requests"
        else:
            # Link to KB detail page
            detail_url = f"{settings.FRONTEND_URL}/knowledge/{kb.id}"

        notification = Notification(
            user_name=target_user.user_name,
            event=event_type.value,
            id=str(kb.id),
            start_time=datetime.utcnow().isoformat(),
            end_time="",
            description=description,
            status="completed",
            detail_url=detail_url,
        )

        await webhook_notification_service.send_notification(notification)
        logger.info(
            f"Sent {event_type.value} notification to user {target_user.user_name} "
            f"for knowledge base {kb.id}"
        )
    except Exception as e:
        # Log error but don't fail the operation
        logger.error(
            f"Failed to send permission notification: {str(e)}",
            exc_info=True,
        )
