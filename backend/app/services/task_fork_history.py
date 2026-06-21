# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fork-aware task history resolution."""

from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.stores.tasks import subtask_store, task_store

MAX_FORK_DEPTH = 50


@dataclass(frozen=True)
class ForkHistoryItem:
    """A subtask plus the fork origin metadata needed by response views."""

    subtask: Subtask
    inherited: bool
    origin_task_id: int
    origin_subtask_id: int


@dataclass(frozen=True)
class ForkLineageNode:
    """One task in a fork chain and the inherited cutoff applied to it."""

    task: TaskResource
    inherited_cutoff: Optional[int]


class TaskForkHistoryResolver:
    """Resolve task history across task-level fork chains."""

    def resolve_for_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        before_message_id: Optional[int] = None,
        after_message_id: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> list[ForkHistoryItem]:
        lineage = self.resolve_lineage(db, task_id=task_id, user_id=user_id)
        items: list[ForkHistoryItem] = []
        current_task_id = lineage[-1].task.id if lineage else task_id

        for node in lineage:
            if node.task.id is None:
                continue
            subtasks = subtask_store.list_by_task_ordered(
                db,
                task_id=node.task.id,
                owner_user_id=node.task.user_id,
            )
            for subtask in subtasks:
                if (
                    node.inherited_cutoff is not None
                    and subtask.message_id > node.inherited_cutoff
                ):
                    continue
                if (
                    before_message_id is not None
                    and subtask.message_id >= before_message_id
                ):
                    continue
                if (
                    after_message_id is not None
                    and subtask.message_id <= after_message_id
                ):
                    continue
                items.append(
                    ForkHistoryItem(
                        subtask=subtask,
                        inherited=node.task.id != current_task_id,
                        origin_task_id=node.task.id,
                        origin_subtask_id=subtask.id,
                    )
                )

        items.sort(
            key=lambda item: (
                item.subtask.message_id,
                item.subtask.created_at,
                item.subtask.id,
            )
        )
        if limit is not None and limit > 0:
            return items[-limit:]
        return items

    def resolve_lineage(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
    ) -> list[ForkLineageNode]:
        nodes_reversed: list[ForkLineageNode] = []
        seen: set[int] = set()
        current_task_id = task_id
        inherited_cutoff: Optional[int] = None

        for _depth in range(MAX_FORK_DEPTH):
            if current_task_id in seen:
                raise ValueError(
                    f"Task fork history cycle detected at task {current_task_id}"
                )
            seen.add(current_task_id)

            task = task_store.get_by_id(
                db,
                task_id=current_task_id,
                owner_user_id=user_id,
            )
            if task is None or task.json is None:
                raise ValueError(
                    f"Task {current_task_id} not found while resolving fork history"
                )

            nodes_reversed.append(
                ForkLineageNode(task=task, inherited_cutoff=inherited_cutoff)
            )
            task_crd = Task.model_validate(task.json)
            fork = task_crd.spec.fork
            if fork is None:
                break

            current_task_id = fork.sourceTaskId
            inherited_cutoff = fork.afterMessageId
        else:
            raise ValueError(f"Task fork history exceeds max depth {MAX_FORK_DEPTH}")

        return list(reversed(nodes_reversed))

    def get_inherited_max_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
    ) -> int:
        task = task_store.get_by_id(db, task_id=task_id, owner_user_id=user_id)
        if task is None or task.json is None:
            return 0
        task_crd = Task.model_validate(task.json)
        fork = task_crd.spec.fork
        return fork.afterMessageId if fork else 0

    def get_next_message_id(self, db: Session, *, task_id: int, user_id: int) -> int:
        local_next = subtask_store.get_next_message_id(
            db,
            task_id=task_id,
            owner_user_id=user_id,
        )
        inherited_next = (
            self.get_inherited_max_message_id(db, task_id=task_id, user_id=user_id) + 1
        )
        return max(local_next, inherited_next)


task_fork_history_resolver = TaskForkHistoryResolver()
