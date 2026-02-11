# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Models package

Note: Import order matters for SQLAlchemy relationship resolution.
Models with relationships should be imported after their related models.

The legacy SharedTask, SharedTeam, and TaskMember models have been removed.
Use ResourceMember for all resource sharing functionality.
"""

from app.models.api_key import APIKey
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.models.project import Project
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import PermissionLevel, ResourceType, ShareLink
from app.models.skill_binary import SkillBinary
from app.models.subscription_follow import (
    SubscriptionFollow,
    SubscriptionShareNamespace,
)
from app.models.subtask import Subtask
from app.models.subtask_context import SubtaskContext
from app.models.system_config import SystemConfig
from app.models.task import TaskResource

# Do NOT import Base here to avoid conflicts with app.db.base.Base
# All models should import Base directly from app.db.base
# Import User last as it may have relationships to other models
from app.models.user import User

__all__ = [
    "User",
    "Kind",
    "TaskResource",
    "Subtask",
    "SubtaskContext",
    "SkillBinary",
    "SystemConfig",
    "Namespace",
    "NamespaceMember",
    "APIKey",
    "KnowledgeDocument",
    "Project",
    "SubscriptionFollow",
    "SubscriptionShareNamespace",
    # Unified share system
    "ShareLink",
    "ResourceMember",
    "ResourceType",
    "PermissionLevel",
    "MemberStatus",
]
