# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task Kinds Service Module

This module provides task management services using the kinds table.
The service is split into multiple files for better maintainability:

- filters.py: Task filtering logic (background tasks, subscription tasks)
- converters.py: Data conversion functions (task dict, team dict)
- helpers.py: Helper functions (create subtasks, batch data fetching)
- queries.py: Query methods (get tasks, search, pagination)
- operations.py: CRUD operations (create, update, delete, cancel)
- service.py: Main service class combining all functionality
"""

from app.services.adapters.task_kinds.service import (
    TaskKindsService,
    task_kinds_service,
)

__all__ = ["TaskKindsService", "task_kinds_service"]
