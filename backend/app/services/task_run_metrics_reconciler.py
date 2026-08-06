# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Repair Redis task run metrics from bounded, indexed MySQL scans."""

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, or_

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.services.task_run_metrics import (
    TaskRunMetricEvent,
    TaskRunMetricsStore,
    task_run_metrics_store,
)

logger = logging.getLogger(__name__)
COMMIT_VISIBILITY_DELAY_SECONDS = 30


@dataclass(frozen=True)
class _TimestampCursor:
    timestamp: datetime
    subtask_id: int

    def serialize(self) -> str:
        return json.dumps(
            {"timestamp": self.timestamp.isoformat(), "subtask_id": self.subtask_id},
            separators=(",", ":"),
        )

    @classmethod
    def parse(cls, value: str | None, default: datetime) -> "_TimestampCursor":
        if not value:
            return cls(default, 0)
        payload = json.loads(value)
        return cls(
            timestamp=datetime.fromisoformat(payload["timestamp"]),
            subtask_id=int(payload["subtask_id"]),
        )


class TaskRunMetricsReconciler:
    """Incrementally replay creations and status changes into Redis."""

    def __init__(
        self,
        store: TaskRunMetricsStore = task_run_metrics_store,
        *,
        batch_size: int = settings.TASK_RUN_METRICS_RECONCILE_BATCH_SIZE,
        max_batches: int = settings.TASK_RUN_METRICS_RECONCILE_MAX_BATCHES,
        retention_days: int = settings.TASK_RUN_METRICS_RETENTION_DAYS,
    ) -> None:
        self._store = store
        self._batch_size = batch_size
        self._max_batches = max_batches
        self._retention_days = retention_days

    def reconcile(self) -> None:
        """Run one bounded reconciliation pass under a distributed lock."""
        token = str(uuid.uuid4())
        lock_seconds = max(
            settings.TASK_RUN_METRICS_RECONCILE_INTERVAL_SECONDS * 10,
            15 * 60,
        )
        if not self._store.acquire_reconcile_lock(token, lock_seconds):
            return
        try:
            cutoff = datetime.now() - timedelta(days=self._retention_days)
            created_count = self._reconcile_created(cutoff)
            changed_count = self._reconcile_status_changes(cutoff)
            if created_count or changed_count:
                logger.info(
                    "Reconciled task run metrics: created=%s status_changes=%s",
                    created_count,
                    changed_count,
                )
        finally:
            self._store.release_reconcile_lock(token)

    def _reconcile_created(self, cutoff: datetime) -> int:
        cursor = _TimestampCursor.parse(self._store.get_cursor("created"), cutoff)
        if cursor.timestamp < cutoff:
            cursor = _TimestampCursor(cutoff, 0)
        upper_bound = datetime.now() - timedelta(
            seconds=COMMIT_VISIBILITY_DELAY_SECONDS
        )

        processed = 0
        for _ in range(self._max_batches):
            with SessionLocal() as db:
                rows = (
                    db.query(
                        Subtask.id,
                        Subtask.created_at,
                        Subtask.status,
                        Subtask.status_changed_at,
                        Subtask.error_message,
                    )
                    .filter(
                        Subtask.role == SubtaskRole.ASSISTANT,
                        Subtask.created_at >= cutoff,
                        Subtask.created_at <= upper_bound,
                        or_(
                            Subtask.created_at > cursor.timestamp,
                            and_(
                                Subtask.created_at == cursor.timestamp,
                                Subtask.id > cursor.subtask_id,
                            ),
                        ),
                    )
                    .order_by(Subtask.created_at.asc(), Subtask.id.asc())
                    .limit(self._batch_size)
                    .all()
                )
            if not rows:
                break

            events = [
                TaskRunMetricEvent(
                    subtask_id=row.id,
                    created_at=row.created_at,
                    status=_status_value(row.status),
                    status_changed_at=row.status_changed_at or row.created_at,
                    error_message=row.error_message,
                    record_total=True,
                    sync_failure=_status_value(row.status) == SubtaskStatus.FAILED,
                )
                for row in rows
            ]
            self._store.record_events(events)
            last = rows[-1]
            cursor = _TimestampCursor(last.created_at, last.id)
            self._store.set_cursor("created", cursor.serialize())
            processed += len(rows)
            if len(rows) < self._batch_size:
                break
        return processed

    def _reconcile_status_changes(self, cutoff: datetime) -> int:
        cursor = _TimestampCursor.parse(self._store.get_cursor("status"), cutoff)
        if cursor.timestamp < cutoff:
            cursor = _TimestampCursor(cutoff, 0)
        upper_bound = datetime.now() - timedelta(
            seconds=COMMIT_VISIBILITY_DELAY_SECONDS
        )

        processed = 0
        for _ in range(self._max_batches):
            with SessionLocal() as db:
                rows = (
                    db.query(
                        Subtask.id,
                        Subtask.created_at,
                        Subtask.status,
                        Subtask.status_changed_at,
                        Subtask.error_message,
                    )
                    .filter(
                        Subtask.role == SubtaskRole.ASSISTANT,
                        Subtask.created_at >= cutoff,
                        Subtask.status_changed_at.isnot(None),
                        Subtask.status_changed_at <= upper_bound,
                        or_(
                            Subtask.status_changed_at > cursor.timestamp,
                            and_(
                                Subtask.status_changed_at == cursor.timestamp,
                                Subtask.id > cursor.subtask_id,
                            ),
                        ),
                    )
                    .order_by(Subtask.status_changed_at.asc(), Subtask.id.asc())
                    .limit(self._batch_size)
                    .all()
                )
            if not rows:
                break

            events = [
                TaskRunMetricEvent(
                    subtask_id=row.id,
                    created_at=row.created_at,
                    status=_status_value(row.status),
                    status_changed_at=row.status_changed_at,
                    error_message=row.error_message,
                    sync_failure=True,
                )
                for row in rows
            ]
            self._store.record_events(events)
            last = rows[-1]
            cursor = _TimestampCursor(last.status_changed_at, last.id)
            self._store.set_cursor("status", cursor.serialize())
            processed += len(rows)
            if len(rows) < self._batch_size:
                break
        return processed


def _status_value(status: SubtaskStatus | str) -> SubtaskStatus:
    return status if isinstance(status, SubtaskStatus) else SubtaskStatus(status)


task_run_metrics_reconciler = TaskRunMetricsReconciler()
