# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SQLAlchemy transaction hooks for task run metrics."""

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.services.task_run_metrics import (
    TaskRunMetricEvent,
    TaskRunMetricsStore,
    task_run_metrics_store,
)

logger = logging.getLogger(__name__)

_TRACKED_OBJECTS_KEY = "task_run_metric_tracked_objects"
_COMMITTED_EVENTS_KEY = "task_run_metric_committed_events"


@dataclass
class _TrackedSubtask:
    subtask: Subtask
    record_total: bool
    sync_failure: bool
    state_changed_at: datetime
    deleted: bool = False


class TaskRunMetricHooks:
    """Capture assistant subtask changes and publish them after commit."""

    def __init__(self, session_factory: Any, store: TaskRunMetricsStore) -> None:
        self._session_factory = session_factory
        self._store = store
        self._registered = False
        self._before_flush_listener = self._before_flush
        self._after_flush_listener = self._after_flush_postexec
        self._after_commit_listener = self._after_commit
        self._after_rollback_listener = self._after_rollback

    def register(self) -> None:
        """Register listeners once for the configured session factory."""
        if self._registered:
            return
        event.listen(self._session_factory, "before_flush", self._before_flush_listener)
        event.listen(
            self._session_factory,
            "after_flush_postexec",
            self._after_flush_listener,
        )
        event.listen(self._session_factory, "after_commit", self._after_commit_listener)
        event.listen(
            self._session_factory, "after_rollback", self._after_rollback_listener
        )
        self._registered = True

    def unregister(self) -> None:
        """Remove listeners, primarily for tests and graceful shutdown."""
        if not self._registered:
            return
        event.remove(self._session_factory, "before_flush", self._before_flush_listener)
        event.remove(
            self._session_factory,
            "after_flush_postexec",
            self._after_flush_listener,
        )
        event.remove(self._session_factory, "after_commit", self._after_commit_listener)
        event.remove(
            self._session_factory, "after_rollback", self._after_rollback_listener
        )
        self._registered = False

    def _before_flush(
        self, session: Session, flush_context: Any, instances: Any
    ) -> None:
        tracked: dict[int, _TrackedSubtask] = session.info.setdefault(
            _TRACKED_OBJECTS_KEY, {}
        )
        now = datetime.now()

        for subtask in session.new:
            if not isinstance(subtask, Subtask) or not _is_assistant(subtask.role):
                continue
            tracked[id(subtask)] = _TrackedSubtask(
                subtask=subtask,
                record_total=True,
                sync_failure=_status_value(subtask.status) == SubtaskStatus.FAILED,
                state_changed_at=now,
            )

        for subtask in session.dirty:
            if not isinstance(subtask, Subtask):
                continue
            state = inspect(subtask)
            status_changed = state.attrs.status.history.has_changes()
            role_changed = state.attrs.role.history.has_changes()
            error_changed = state.attrs.error_message.history.has_changes()
            current_failed = _status_value(subtask.status) == SubtaskStatus.FAILED
            if not (
                status_changed or role_changed or (error_changed and current_failed)
            ):
                continue
            if not (_is_assistant(subtask.role) or _was_assistant(state)):
                continue
            previous = tracked.get(id(subtask))
            tracked[id(subtask)] = _TrackedSubtask(
                subtask=subtask,
                record_total=previous.record_total if previous else False,
                sync_failure=True,
                state_changed_at=now,
            )

        for subtask in session.deleted:
            if not isinstance(subtask, Subtask) or not _is_assistant(subtask.role):
                continue
            previous = tracked.get(id(subtask))
            tracked[id(subtask)] = _TrackedSubtask(
                subtask=subtask,
                record_total=previous.record_total if previous else False,
                sync_failure=True,
                state_changed_at=now,
                deleted=True,
            )

    def _after_flush_postexec(self, session: Session, flush_context: Any) -> None:
        tracked: dict[int, _TrackedSubtask] = session.info.pop(_TRACKED_OBJECTS_KEY, {})
        committed: dict[int, TaskRunMetricEvent] = session.info.setdefault(
            _COMMITTED_EVENTS_KEY, {}
        )
        for item in tracked.values():
            subtask = item.subtask
            if not subtask.id or not subtask.created_at:
                continue
            previous = committed.get(subtask.id)
            committed[subtask.id] = TaskRunMetricEvent(
                subtask_id=subtask.id,
                created_at=subtask.created_at,
                status=(
                    SubtaskStatus.DELETE
                    if item.deleted
                    else _status_value(subtask.status)
                ),
                state_changed_at=item.state_changed_at,
                error_message=subtask.error_message,
                record_total=item.record_total
                or (previous.record_total if previous else False),
                sync_failure=item.sync_failure
                or (previous.sync_failure if previous else False),
            )

    def _after_commit(self, session: Session) -> None:
        committed: dict[int, TaskRunMetricEvent] = session.info.pop(
            _COMMITTED_EVENTS_KEY, {}
        )
        session.info.pop(_TRACKED_OBJECTS_KEY, None)
        if not committed:
            return
        try:
            self._store.record_events(committed.values())
        except Exception:
            logger.exception(
                "Failed to publish committed task run metrics; statistics may be incomplete"
            )

    @staticmethod
    def _after_rollback(session: Session) -> None:
        session.info.pop(_TRACKED_OBJECTS_KEY, None)
        session.info.pop(_COMMITTED_EVENTS_KEY, None)


def _is_assistant(role: Any) -> bool:
    return role is None or role == SubtaskRole.ASSISTANT


def _was_assistant(state: Any) -> bool:
    return any(_is_assistant(role) for role in state.attrs.role.history.deleted)


def _status_value(status: Any) -> SubtaskStatus:
    if status is None:
        return SubtaskStatus.PENDING
    if isinstance(status, SubtaskStatus):
        return status
    return SubtaskStatus(status)


def queue_bulk_subtask_status_metrics(
    session: Session,
    subtasks: Iterable[Subtask],
    *,
    status: SubtaskStatus,
) -> None:
    """Queue metrics for a bulk status update that bypasses ORM flush hooks."""
    committed: dict[int, TaskRunMetricEvent] = session.info.setdefault(
        _COMMITTED_EVENTS_KEY, {}
    )
    state_changed_at = datetime.now()
    for subtask in subtasks:
        if not _is_assistant(subtask.role) or not subtask.id or not subtask.created_at:
            continue
        previous = committed.get(subtask.id)
        committed[subtask.id] = TaskRunMetricEvent(
            subtask_id=subtask.id,
            created_at=subtask.created_at,
            status=status,
            state_changed_at=state_changed_at,
            error_message=subtask.error_message,
            record_total=previous.record_total if previous else False,
            sync_failure=True,
        )


task_run_metric_hooks = TaskRunMetricHooks(SessionLocal, task_run_metrics_store)
