# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Models package

Note: Import order matters for SQLAlchemy relationship resolution.
Models with relationships should be imported after their related models.
"""
from app.models.api_key import APIKey
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.models.project import Project
from app.models.shared_task import SharedTask
from app.models.shared_team import SharedTeam
from app.models.skill_binary import SkillBinary
from app.models.subscription_follow import (
    SubscriptionFollow,
    SubscriptionShareNamespace,
)
from app.models.subtask import Subtask
from app.models.subtask_context import SubtaskContext
from app.models.system_config import SystemConfig
from app.models.task import TaskResource
from app.models.task_member import TaskMember

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
    "SharedTask",
    "SharedTeam",
    "SkillBinary",
    "SystemConfig",
    "Namespace",
    "NamespaceMember",
    "APIKey",
    "TaskMember",
    "KnowledgeDocument",
    "Project",
    "SubscriptionFollow",
    "SubscriptionShareNamespace",
]
