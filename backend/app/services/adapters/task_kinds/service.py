# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task Kinds Service.

This module provides the main TaskKindsService class that combines
all task-related functionality using mixins.
"""

from app.models.kind import Kind
from app.schemas.task import TaskCreate, TaskUpdate
from app.services.base import BaseService

from .operations import TaskOperationsMixin
from .queries import TaskQueryMixin


class TaskKindsService(
    TaskQueryMixin, TaskOperationsMixin, BaseService[Kind, TaskCreate, TaskUpdate]
):
    """
    Task service class using kinds table.

    This service provides comprehensive task management functionality including:
    - Task CRUD operations (create, update, delete, cancel)
    - Task queries with pagination and filtering
    - Pipeline stage management
    - Group chat support

    The service is organized using mixins:
    - TaskQueryMixin: Query methods (get_user_tasks_*, get_task_by_id, etc.)
    - TaskOperationsMixin: CRUD operations (create, update, delete, cancel)
    """

    pass


# Create singleton instance
task_kinds_service = TaskKindsService(Kind)
