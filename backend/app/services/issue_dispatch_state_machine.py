# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""ORM state transitions for the Issue dispatch aggregate."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.models.delivery import IssueDispatch, IssueDispatchRound, IssueDispatchTask
from app.services.issue_dispatch_domain import (
    DispatchConflict,
    DispatchStatus,
    RoundStatus,
    TaskStatus,
)

ACTIVE_ROUND_STATUSES = frozenset({"planning", "executing", "evaluating"})
TERMINAL_TASK_STATUSES = frozenset({"submitted", "failed", "needs_rework", "cancelled"})


class IssueDispatchStateMachine:
    """Apply every legal task, round, and dispatch transition in one place."""

    def start_task(self, task: IssueDispatchTask) -> None:
        if task.status == "running":
            return
        if task.status not in {"assigned", "queued"}:
            raise DispatchConflict(f"Cannot start dispatch task from {task.status}")
        task.status = "running"
        task.version += 1

    def finish_task(
        self,
        task: IssueDispatchTask,
        *,
        status: TaskStatus,
        summary: str,
        delivery_id: str | None,
    ) -> None:
        if task.status in TERMINAL_TASK_STATUSES:
            raise DispatchConflict("Dispatch task already has a terminal outcome")
        if status not in TERMINAL_TASK_STATUSES:
            raise DispatchConflict(f"Dispatch task outcome is not terminal: {status}")
        task.status = status
        task.current_delivery_id = delivery_id
        task.description = summary
        task.completed_at = self.now()
        task.version += 1

    def return_task_for_rework(self, task: IssueDispatchTask, *, reason: str) -> None:
        if task.status != "submitted":
            raise DispatchConflict("Only a submitted task can be returned for rework")
        task.status = "needs_rework"
        task.description = reason or "Returned for rework"
        task.completed_at = self.now()
        task.version += 1

    def begin_round(
        self, round_record: IssueDispatchRound, dispatch: IssueDispatch
    ) -> None:
        self._require_round_status(round_record, {"planning"})
        round_record.status = "executing"
        round_record.version += 1
        self._set_active_round(dispatch, round_record.id)

    def apply_round_barrier(
        self, round_record: IssueDispatchRound, *, status: RoundStatus
    ) -> None:
        self._require_round_status(round_record, {"executing", "evaluating"})
        if status not in {"executing", "evaluating"}:
            raise DispatchConflict(f"Invalid round barrier status: {status}")
        if round_record.status == status:
            return
        round_record.status = status
        round_record.version += 1

    def close_round(self, round_record: IssueDispatchRound) -> None:
        self._require_round_status(round_record, {"evaluating"})
        round_record.status = "closed"
        round_record.completed_at = self.now()
        round_record.version += 1

    def cancel_round(self, round_record: IssueDispatchRound) -> None:
        if round_record.status not in ACTIVE_ROUND_STATUSES:
            return
        round_record.status = "cancelled"
        round_record.completed_at = self.now()
        round_record.version += 1

    def cancel_task(self, task: IssueDispatchTask) -> None:
        if task.status in TERMINAL_TASK_STATUSES:
            return
        task.status = "cancelled"
        task.completed_at = self.now()
        task.version += 1

    def complete_dispatch(self, dispatch: IssueDispatch) -> None:
        self._require_dispatch_status(dispatch, {"active"})
        dispatch.status = "completed"
        dispatch.completed_at = self.now()
        self._set_active_round(dispatch, None, increment=False)
        dispatch.version += 1

    def cancel_dispatch(self, dispatch: IssueDispatch) -> None:
        self._require_dispatch_status(dispatch, {"active"})
        dispatch.status = "cancelled"
        dispatch.completed_at = self.now()
        self._set_active_round(dispatch, None, increment=False)
        dispatch.version += 1

    def reopen_dispatch(self, dispatch: IssueDispatch) -> bool:
        if dispatch.status == "active":
            return False
        self._require_dispatch_status(dispatch, {"completed"})
        dispatch.status = "active"
        dispatch.completed_at = None
        dispatch.version += 1
        return True

    @staticmethod
    def metadata(record: Any) -> dict[str, Any]:
        value = getattr(record, "metadata_json", None)
        return dict(value) if isinstance(value, dict) else {}

    @staticmethod
    def now() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)

    def _set_active_round(
        self,
        dispatch: IssueDispatch,
        round_id: str | None,
        *,
        increment: bool = True,
    ) -> None:
        dispatch.metadata_json = {
            **self.metadata(dispatch),
            "active_round_id": round_id,
        }
        if increment:
            dispatch.version += 1

    @staticmethod
    def _require_round_status(
        round_record: IssueDispatchRound, allowed: set[str]
    ) -> None:
        if round_record.status not in allowed:
            raise DispatchConflict(
                f"Cannot transition dispatch round from {round_record.status}"
            )

    @staticmethod
    def _require_dispatch_status(dispatch: IssueDispatch, allowed: set[str]) -> None:
        if dispatch.status not in allowed:
            raise DispatchConflict(f"Cannot transition dispatch from {dispatch.status}")


issue_dispatch_state_machine = IssueDispatchStateMachine()
