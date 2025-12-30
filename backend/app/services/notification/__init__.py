# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Notification services for Wegent.
"""

from app.services.notification.dingtalk import DingtalkClient, DingtalkUser
from app.services.notification.email_client import EmailClient
from app.services.notification.group_chat_summary import (
    GroupChatSummaryService,
    get_group_chat_summary_service,
)
from app.services.notification.unread_notification import (
    UnreadNotificationService,
    get_unread_notification_service,
)

__all__ = [
    "DingtalkClient",
    "DingtalkUser",
    "EmailClient",
    "GroupChatSummaryService",
    "get_group_chat_summary_service",
    "UnreadNotificationService",
    "get_unread_notification_service",
]
