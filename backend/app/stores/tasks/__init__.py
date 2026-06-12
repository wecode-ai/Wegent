# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.stores.tasks.interfaces import (
    SubtaskStore,
    TaskAccessStore,
    TaskStore,
    WorkspaceRefLookup,
)
from app.stores.tasks.sqlalchemy_access_store import SqlAlchemyTaskAccessStore
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore

task_store: TaskStore = SqlAlchemyTaskStore()
subtask_store: SubtaskStore = SqlAlchemySubtaskStore()
task_access_store: TaskAccessStore = SqlAlchemyTaskAccessStore()

__all__ = [
    "SqlAlchemySubtaskStore",
    "SqlAlchemyTaskAccessStore",
    "SqlAlchemyTaskStore",
    "SubtaskStore",
    "TaskAccessStore",
    "TaskStore",
    "WorkspaceRefLookup",
    "subtask_store",
    "task_access_store",
    "task_store",
]
