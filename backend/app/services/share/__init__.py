# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Share services package for unified resource sharing.

Provides base share service and resource-specific implementations.
"""

from app.services.share.base_service import UnifiedShareService
from app.services.share.knowledge_share_service import (
    KnowledgeShareService,
    knowledge_share_service,
)
from app.services.share.share_webhook import (
    send_share_request_notification,
    send_share_review_notification,
)
from app.services.share.task_share_service import TaskShareService, task_share_service
from app.services.share.team_share_service import TeamShareService, team_share_service

__all__ = [
    "UnifiedShareService",
    "TeamShareService",
    "team_share_service",
    "TaskShareService",
    "task_share_service",
    "KnowledgeShareService",
    "knowledge_share_service",
    "send_share_request_notification",
    "send_share_review_notification",
]
