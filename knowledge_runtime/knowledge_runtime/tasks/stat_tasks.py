# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Celery tasks for KB stat collection."""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Optional, Sequence

import redis
from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy import text

from knowledge_engine.stat import (
    collect_all,
    mark_kb_stat_orphaned_runs,
    mark_kb_stat_stale_runs,
    prune_old_runs,
)
from knowledge_runtime.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)


# Ensures kb_stat collection logs are mirrored to kb_stat_worker.log. Configured
# lazily on the first task run so only the worker process that actually executes
# collection gets the file handler (the API process imports this module too but
# never runs collect_all, so it should not create the file).
_KB_STAT_WORKER_LOG_CONFIGURED = False


def _ensure_worker_logging() -> None:
    global _KB_STAT_WORKER_LOG_CONFIGURED
    if _KB_STAT_WORKER_LOG_CONFIGURED:
        return
    _KB_STAT_WORKER_LOG_CONFIGURED = True
    try:
        from knowledge_runtime.config import get_settings
        from knowledge_runtime.core.logging import setup_kb_stat_worker_logging

        s = get_settings()
        if s.log_file_enabled:
            setup_kb_stat_worker_logging(s.log_dir, s.log_level)
            logger.info(
                "[kb_stat] worker logging initialised -> %s/kb_stat_worker.log",
                s.log_dir,
            )
    except Exception:  # noqa: BLE001 - logging setup must never break collection
        logger.warning("[kb_stat] failed to setup kb_stat_worker.log", exc_info=True)


class KbStatRunInProgressError(RuntimeError):
    """Raised when a collection for ``target_date`` is already running.

    Carries the ``existing_run_id`` (if discoverable) so the API layer can
    surface it to the caller as a 409 instead of a generic 500.
    """

    def __init__(
        self, target_date: date, existing_run_id: Optional[int] = None
    ) -> None:
        self.target_date = target_date
        self.existing_run_id = existing_run_id
        super().__init__(
            f"kb_stat collection already in progress for {target_date}"
            + (f" (run_id={existing_run_id})" if existing_run_id else "")
        )


class KbStatLockUnavailableError(RuntimeError):
    """Raised when the authoritative Redis collection lock is unavailable."""


def _build_lock_redis(settings) -> Optional[redis.Redis]:
    """Build a Redis client for the per-date collection lock.

    Reuses the Celery broker Redis. A missing URL is reported to the caller;
    collection must never silently degrade to lock-less execution.
    """
    url = settings.celery_broker_url
    if not url:
        return None
    try:
        return redis.Redis.from_url(url, socket_connect_timeout=2, socket_timeout=2)
    except Exception:  # noqa: BLE001 - never let lock setup crash the task
        logger.warning("[kb_stat] failed to build lock redis client", exc_info=True)
        return None


def _find_running_run(target_date: date) -> Optional[int]:
    """Return the id of a currently 'running' run for ``target_date``, if any."""
    from shared.db.stat_session import get_stat_session_factory

    try:
        session = get_stat_session_factory()()
        try:
            row = session.execute(
                text(
                    "SELECT id FROM kb_stat_runs "
                    "WHERE target_date = :d AND status = 'running' "
                    "ORDER BY id DESC LIMIT 1"
                ),
                {"d": target_date},
            ).fetchone()
            return int(row.id) if row else None
        finally:
            session.close()
    except Exception:  # noqa: BLE001 - lock metadata is best-effort
        return None


@celery_app.task(
    bind=True,
    name="kb_stat.collect_all",
    queue="kb_stat",
    soft_time_limit=1500,
    time_limit=1800,
    acks_late=True,
)
def collect_all_metrics_task(
    self,
    target_date_iso: Optional[str] = None,
    kb_ids: Optional[Sequence[int]] = None,
    domains: Optional[Sequence[str]] = None,
    collector_names: Optional[Sequence[str]] = None,
    triggered_by: str = "beat",
    triggered_user_id: Optional[int] = None,
    lookback_days: Optional[int] = None,
    advanced_enabled: Optional[bool] = None,
):
    target = (
        date.fromisoformat(target_date_iso)
        if target_date_iso
        else datetime.now(timezone.utc).date()
    )

    # Mirror collection logs to kb_stat_worker.log (idempotent, worker-only).
    _ensure_worker_logging()

    from knowledge_runtime.config import get_settings

    settings = get_settings()

    # Feature switch short-circuit: KB_STAT_ENABLED=false must stop not only
    # the beat schedule (handled in backend celery_app.py) but also already-
    # queued tasks (manual API trigger, retry, or a task enqueued before the
    # flag was flipped during a rolling restart). Bail out before acquiring
    # the Redis lock so we never hold it for a disabled feature.
    if not settings.kb_stat_enabled:
        logger.info(
            "[kb_stat] collect_all skipped (KB_STAT_ENABLED=false, target=%s, by=%s)",
            target.isoformat(),
            triggered_by,
        )
        return {"skipped": "kb_stat_disabled", "target_date": target.isoformat()}

    from shared.db.readonly_session import get_readonly_session_factory
    from shared.db.stat_session import get_stat_session_factory

    # Per-target_date distributed lock: prevents concurrent collectors for
    # the same date (beat vs manual_api vs retry vs multi-instance worker).
    # Different dates may run in parallel. Redis is the authoritative lock;
    # fail closed when it is unavailable instead of risking duplicate writes.
    lock_token = None
    lock_name = f"kb_stat:lock:{target.isoformat()}"
    lock_redis = _build_lock_redis(settings)
    if lock_redis is None:
        error = KbStatLockUnavailableError(
            "kb_stat collection lock is unavailable: CELERY_BROKER_URL is not configured"
        )
        raise self.retry(
            exc=error,
            countdown=min(60, 5 * (2**self.request.retries)),
            max_retries=3,
        )
    try:
        from shared.common.distributed_lock import DistributedLock

        lock = DistributedLock(redis_client=lock_redis)
        lock_token = lock.acquire(
            lock_name, expire_seconds=settings.kb_stat_lock_ttl_seconds
        )
        if lock_token is None:
            existing = _find_running_run(target)
            logger.warning(
                "[kb_stat] lock contention on %s (existing_run_id=%s)",
                target,
                existing,
            )
            raise KbStatRunInProgressError(target, existing_run_id=existing)
    except KbStatRunInProgressError:
        raise
    except Exception as exc:
        logger.error("[kb_stat] failed to acquire collection lock", exc_info=True)
        error = KbStatLockUnavailableError("kb_stat collection lock is unavailable")
        raise self.retry(
            exc=error,
            countdown=min(60, 5 * (2**self.request.retries)),
            max_retries=3,
        ) from exc

    try:
        # Owning the date lock proves any older running DB row for this date
        # lost its worker. Reconcile it before creating a replacement run.
        mark_kb_stat_orphaned_runs(
            target_date=target,
            stat_session_factory=get_stat_session_factory(),
        )
        try:
            mark_kb_stat_stale_runs(
                stale_minutes=settings.kb_stat_stale_minutes,
                stat_session_factory=get_stat_session_factory(),
            )
        except Exception:
            logger.warning(
                "[kb_stat] failed to mark stale runs, continuing", exc_info=True
            )

        try:
            run_id = collect_all(
                target_date=target,
                kb_ids=kb_ids,
                domains=domains,
                collector_names=collector_names,
                triggered_by=triggered_by,
                triggered_user_id=triggered_user_id,
                lookback_days=(
                    lookback_days
                    if lookback_days is not None
                    else settings.knowledge_stat_lookback_days
                ),
                advanced_enabled=(
                    advanced_enabled
                    if advanced_enabled is not None
                    else settings.kb_stat_advanced_enabled
                ),
                source_session_factory=get_readonly_session_factory(),
                stat_session_factory=get_stat_session_factory(),
            )
            logger.info(f"[kb_stat] collect_all run_id={run_id} date={target} done")
            return {"run_id": run_id, "target_date": target.isoformat()}
        except SoftTimeLimitExceeded:
            logger.error("[kb_stat] soft time limit exceeded")
            raise
    finally:
        if lock_token is not None:
            try:
                from shared.common.distributed_lock import DistributedLock

                DistributedLock(redis_client=lock_redis).release(lock_name, lock_token)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "[kb_stat] failed to release lock %s", lock_name, exc_info=True
                )


@celery_app.task(
    name="kb_stat.prune_old_runs",
    queue="kb_stat",
    # prune scans 70+ stat tables and batch-deletes old runs; bound it so a
    # runaway prune cannot pin the single kb_stat worker indefinitely and
    # starve the daily collect. Mirrors collect_all's hard > soft margin.
    soft_time_limit=1200,
    time_limit=1500,
    # Re-queue if the worker dies mid-prune. prune is idempotent (a duplicate
    # run only re-deletes already-absent rows), so acks_late is safe here and
    # prevents silent data-retention drift after a crash.
    acks_late=True,
)
def prune_old_runs_task(retention_days: Optional[int] = None):
    """Prune runs older than the configured retention window.

    ``retention_days`` is optional so the weekly beat can call the task with no
    kwargs: the value is then read from ``KNOWLEDGE_STAT_RETENTION_DAYS`` via
    settings. A manual ``celery call`` may override it explicitly. This makes
    operator changes to the env var actually take effect — previously the beat
    never passed the value and the task fell back to its hardcoded default.
    """
    from knowledge_runtime.config import get_settings

    settings = get_settings()
    days = (
        retention_days
        if retention_days is not None
        else settings.knowledge_stat_retention_days
    )

    # Defense-in-depth: prune_old_runs also checks <=0 internally, but we
    # short-circuit here too so no DB session is opened when the operator
    # has set KNOWLEDGE_STAT_RETENTION_DAYS<=0 (retain-forever mode).
    if days <= 0:
        logger.info("[kb_stat] prune task skipped (retention_days=%s<=0)", days)
        return 0
    from shared.db.stat_session import get_stat_session_factory

    return prune_old_runs(
        retention_days=days,
        stat_session_factory=get_stat_session_factory(),
    )
