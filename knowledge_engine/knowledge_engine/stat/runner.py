# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Collection runner: orchestrates all registered collectors.

Creates a run record, executes each collector in its own transaction,
and handles failure isolation.
"""

import json
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional, Sequence

# SoftTimeLimitExceeded is a celery exception; import lazily so the engine
# can be used without celery installed (e.g. CLI scripts). The try/except
# guard ensures this module loads even if celery is not in the environment.
try:
    from celery.exceptions import SoftTimeLimitExceeded
except ImportError:  # pragma: no cover

    class SoftTimeLimitExceeded(Exception):
        """Fallback when celery is not installed."""


from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from knowledge_engine.stat.filters import MetricFilter
from knowledge_engine.stat.models.runs import CollectorRun, Run
from knowledge_engine.stat.registry import (
    all_collectors,
    collectors_by_domains,
    collectors_by_names,
)

logger = logging.getLogger(__name__)


# Patterns that indicate an exception message may leak internal topology
# (DB host/DSN, file paths, SQL fragments). Such messages are persisted to
# kb_stat_runs/kb_stat_collector_runs.error_message and surfaced via the
# admin API, so they must not carry infrastructure detail.
_SENSITIVE_PATTERNS = re.compile(
    r"(mysql://|mysql\+pymysql://|postgresql://|redis://|amqp://|"
    r"/[a-zA-Z0-9_\-]+/[\w\-.]+\.(py|sql|json)|"
    r"Host '[^']+'|host=\S+|port=\d+|password=\S+|user=\S+)",
    re.IGNORECASE,
)

# Ceiling on the sanitized message length (DB column is TEXT, but admin UI
# only renders a snippet).
_MAX_ERR_LEN = 300


def _sanitize_error(exc: BaseException) -> str:
    """Return a client-safe error string for persistence.

    Keeps the exception class name (useful for ops triage, not sensitive)
    but drops the raw message when it matches sensitive patterns. The full
    traceback is already written to the server log by the caller.
    """
    cls = type(exc).__name__
    msg = str(exc)
    if not msg:
        return cls[:_MAX_ERR_LEN]
    if _SENSITIVE_PATTERNS.search(msg):
        return f"{cls} (details redacted; see server log)"[:_MAX_ERR_LEN]
    return f"{cls}: {msg}"[:_MAX_ERR_LEN]


def collect_all(
    *,
    target_date: date,
    kb_ids: Optional[Sequence[int]] = None,
    triggered_by: str = "beat",
    triggered_user_id: Optional[int] = None,
    domains: Optional[Sequence[str]] = None,
    collector_names: Optional[Sequence[str]] = None,
    lookback_days: int = 30,
    source_session_factory: Callable[[], Session],
    stat_session_factory: Callable[[], Session],
) -> int:
    """Run all (or selected domain) collectors and return the run_id.

    Each collector executes in its own transaction boundary.
    A single collector failure does not prevent others from running.
    """
    # Trigger collector registration
    import knowledge_engine.stat.collectors  # noqa: F401

    mfilter = MetricFilter(
        target_date=target_date, kb_ids=kb_ids, lookback_days=lookback_days
    )

    # Validate the requested selection before creating a run. An unknown
    # domain must not produce an empty run that is incorrectly marked complete.
    if collector_names:
        collectors = collectors_by_names(collector_names)
    elif domains:
        collectors = collectors_by_domains(domains)
    else:
        collectors = all_collectors()
    if not collectors:
        raise ValueError("No enabled collectors selected")

    stat_session = stat_session_factory()
    # Create run record
    run_id = _create_run(
        stat_session,
        target_date=target_date,
        kb_ids=kb_ids,
        triggered_by=triggered_by,
        triggered_user_id=triggered_user_id,
        stat_start=mfilter.effective_period_start,
        stat_end=mfilter.period_end_date,
    )

    total_rows = 0
    collector_results: list[str] = []  # track success/failed per collector

    try:
        for collector in collectors:
            collector_run_id = _create_collector_run(
                stat_session,
                run_id=run_id,
                domain=collector.domain,
                name=collector.name,
            )
            collector_started = time.monotonic()
            source_session: Optional[Session] = None
            try:
                # Keep source-side read transactions short. Reusing one
                # session for all collectors can retain a MySQL MVCC snapshot
                # for the entire 20-30 minute run.
                source_session = source_session_factory()
                stat_session.begin()
                rows = collector.fn(
                    run_id,
                    mfilter,
                    source_session=source_session,
                    stat_session=stat_session,
                )
                stat_session.commit()
                duration_ms = int((time.monotonic() - collector_started) * 1000)
                _update_collector_run(
                    stat_session,
                    collector_run_id,
                    status="success",
                    rows_written=rows or 0,
                    duration_ms=duration_ms,
                )
                total_rows += rows or 0
                collector_results.append("success")
                logger.info(
                    "[kb_stat] run_id=%s collector=%s success rows=%s duration_ms=%s",
                    run_id,
                    collector.name,
                    rows or 0,
                    duration_ms,
                )
            except SoftTimeLimitExceeded:
                # Re-raise so stat_tasks.py's soft-time-limit handler fires
                # and the run aborts cleanly. Without this the except Exception
                # below swallows the soft timeout, the loop continues running
                # collectors past the deadline, and only the hard time_limit
                # (which kills the worker) stops it.
                stat_session.rollback()
                duration_ms = int((time.monotonic() - collector_started) * 1000)
                _update_collector_run(
                    stat_session,
                    collector_run_id,
                    status="failed",
                    duration_ms=duration_ms,
                    error_message="soft time limit exceeded",
                )
                logger.warning(
                    "[kb_stat] run_id=%s collector=%s failed duration_ms=%s "
                    "error=soft time limit exceeded",
                    run_id,
                    collector.name,
                    duration_ms,
                )
                raise
            except Exception as e:
                stat_session.rollback()
                duration_ms = int((time.monotonic() - collector_started) * 1000)
                _update_collector_run(
                    stat_session,
                    collector_run_id,
                    status="failed",
                    duration_ms=duration_ms,
                    error_message=_sanitize_error(e),
                )
                logger.warning(
                    "[kb_stat] run_id=%s collector=%s failed duration_ms=%s error=%s",
                    run_id,
                    collector.name,
                    duration_ms,
                    _sanitize_error(e),
                )
                collector_results.append("failed")
            finally:
                if source_session is not None:
                    source_session.close()

        # Determine overall run status
        if all(r == "success" for r in collector_results):
            run_status = "completed"
        elif any(r == "success" for r in collector_results):
            run_status = "partial"
        else:
            run_status = "failed"

        failed_names = [
            c.name for c, r in zip(collectors, collector_results) if r == "failed"
        ]
        error_msg = ", ".join(failed_names) if failed_names else None
    except Exception as exc:
        run_status = "failed"
        error_msg = _sanitize_error(exc)
        logger.error(f"[kb_stat] run_id={run_id} aborted: {exc}")

    _finalize_run(
        stat_session,
        run_id=run_id,
        status=run_status,
        metrics_count=total_rows,
        error_message=error_msg,
    )

    stat_session.close()

    logger.info(
        f"[kb_stat] run_id={run_id} target_date={target_date} "
        f"status={run_status} metrics_count={total_rows}"
    )
    return run_id


def prune_old_runs(
    *,
    retention_days: int = 400,
    stat_session_factory: Callable[[], Session],
) -> int:
    """Delete runs older than retention_days. Returns count of deleted runs.

    Special case: ``retention_days <= 0`` disables pruning entirely
    (retain forever). This guards against accidental mass-deletion when
    someone sets ``KNOWLEDGE_STAT_RETENTION_DAYS=0`` expecting "no
    retention" — the arithmetic ``today - 0`` would otherwise make
    ``cutoff = today`` and delete every run with ``target_date < today``
    (i.e. almost the entire stat DB).

    The recommended way to retain data forever is setting
    ``KB_STAT_PRUNE_ENABLED=false`` on the backend (drops the prune beat),
    but this short-circuit is a safety net for manual invocations
    (``celery call kb_stat.prune_old_runs``, ``kb_stat_backfill.py``).
    """
    if retention_days <= 0:
        logger.info(
            "[kb_stat] pruning disabled (retention_days=%s <= 0); "
            "all historical data retained",
            retention_days,
        )
        return 0

    stat_session = stat_session_factory()
    cutoff = datetime.now(timezone.utc).date()
    cutoff_date = cutoff - timedelta(days=retention_days)

    # Delete metric rows associated with old runs first
    # Due to foreign key concerns, delete by run_id
    old_runs = stat_session.execute(
        text(
            "SELECT id FROM kb_stat_runs WHERE target_date < :cutoff AND status != 'running'"
        ),
        {"cutoff": cutoff_date},
    ).fetchall()

    if not old_runs:
        stat_session.close()
        return 0

    run_ids = [r.id for r in old_runs]

    # Discover all stat metric tables from the ORM metadata so newly added
    # tables are pruned automatically — a hardcoded list silently goes stale
    # (it already missed the per-KB detail tables). kb_stat_runs is deleted
    # separately below.
    import knowledge_engine.stat.models.metrics  # noqa: F401
    import knowledge_engine.stat.models.pipeline  # noqa: F401
    from knowledge_engine.stat.models.base import StatBase

    metric_tables = sorted(
        name
        for name, table in StatBase.metadata.tables.items()
        if name.startswith("kb_stat_")
        and name != "kb_stat_runs"
        and "run_id" in table.columns
    )

    # Chunk the run_ids to avoid a single massive transaction that holds
    # locks for too long (the prune runs weekly and may delete several days'
    # worth of runs across 70+ tables). Each chunk is committed independently.
    CHUNK_SIZE = 100
    total_deleted = 0

    for chunk_start in range(0, len(run_ids), CHUNK_SIZE):
        chunk = run_ids[chunk_start : chunk_start + CHUNK_SIZE]
        placeholders = ", ".join(f":rid_{i}" for i in range(len(chunk)))
        params = {f"rid_{i}": rid for i, rid in enumerate(chunk)}

        try:
            for table in metric_tables:
                stat_session.execute(
                    text(f"DELETE FROM `{table}` WHERE run_id IN ({placeholders})"),
                    params,
                )

            # Delete the runs themselves
            stat_session.execute(
                text(f"DELETE FROM kb_stat_runs WHERE id IN ({placeholders})"),
                params,
            )

            stat_session.commit()
            total_deleted += len(chunk)
            logger.info(
                "[kb_stat] pruned chunk %d/%d (%d runs)",
                chunk_start // CHUNK_SIZE + 1,
                (len(run_ids) + CHUNK_SIZE - 1) // CHUNK_SIZE,
                len(chunk),
            )
        except Exception:
            stat_session.rollback()
            logger.warning(
                "[kb_stat] prune chunk failed at offset %d, skipping",
                chunk_start,
                exc_info=True,
            )

    stat_session.close()

    logger.info(f"[kb_stat] pruned {total_deleted} runs older than {cutoff_date}")
    return total_deleted


_STALE_RUN_ERROR_MESSAGE = "Run timed out (worker may have crashed)"
_ORPHANED_RUN_ERROR_MESSAGE = "Run abandoned after its collection lock expired"


def mark_kb_stat_orphaned_runs(
    *,
    target_date: date,
    stat_session_factory: Callable[[], Session],
) -> int:
    """Fail running rows for a date after acquiring its previously free lock.

    A running database row cannot still own the date lock at this point. It is
    therefore an orphan from a crashed or hard-killed worker, regardless of the
    broader stale-run timeout.
    """
    with stat_session_factory() as stat_session:
        params = {"err": _ORPHANED_RUN_ERROR_MESSAGE, "target_date": target_date}
        stat_session.execute(
            text(
                """
                UPDATE kb_stat_collector_runs c
                JOIN kb_stat_runs r ON r.id = c.run_id
                SET c.status = 'failed', c.completed_at = NOW(),
                    c.error_message = :err
                WHERE c.status = 'running'
                  AND r.status = 'running'
                  AND r.target_date = :target_date
                """
            ),
            params,
        )
        result = stat_session.execute(
            text(
                """
                UPDATE kb_stat_runs
                SET status = 'failed', completed_at = NOW(),
                    error_message = :err
                WHERE status = 'running'
                  AND target_date = :target_date
                """
            ),
            params,
        )
        stat_session.commit()
        marked = result.rowcount

    if marked:
        logger.warning(
            "[kb_stat] marked %d orphaned run(s) for %s as failed",
            marked,
            target_date,
        )
    return marked


def mark_kb_stat_stale_runs(
    *,
    stale_minutes: int = 60,
    stat_session_factory: Callable[[], Session],
) -> int:
    """Mark runs stuck in 'running' for longer than stale_minutes as 'failed'.

    This handles cases where the Celery worker crashed or was killed before
    updating the run status. Returns count of marked runs.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=stale_minutes)
    with stat_session_factory() as stat_session:
        stat_session.execute(
            text(
                """
                UPDATE kb_stat_collector_runs c
                JOIN kb_stat_runs r ON r.id = c.run_id
                SET c.status = 'failed', c.completed_at = NOW(),
                    c.error_message = :err
                WHERE c.status = 'running'
                  AND r.status = 'running'
                  AND r.started_at < :cutoff
                """
            ),
            {"err": _STALE_RUN_ERROR_MESSAGE, "cutoff": cutoff},
        )
        result = stat_session.execute(
            text(
                """
            UPDATE kb_stat_runs
            SET status = 'failed', completed_at = NOW(),
                error_message = :err
            WHERE status = 'running'
              AND started_at < :cutoff
        """
            ),
            {"err": _STALE_RUN_ERROR_MESSAGE, "cutoff": cutoff},
        )
        stat_session.commit()
        marked = result.rowcount

    if marked:
        logger.info(f"[kb_stat] marked {marked} stale run(s) as failed")
    return marked


def _create_run(
    session: Session,
    *,
    target_date: date,
    kb_ids: Optional[Sequence[int]],
    triggered_by: str,
    triggered_user_id: Optional[int],
    stat_start: date,
    stat_end: date,
) -> int:
    result = session.execute(
        text(
            """
            INSERT INTO kb_stat_runs
                (started_at, status, target_date, kb_filter, triggered_by,
                 triggered_user_id, stat_start, stat_end, metrics_count)
            VALUES (NOW(), 'running', :target_date, :kb_filter, :triggered_by,
                    :triggered_user_id, :stat_start, :stat_end, 0)
        """
        ),
        {
            "target_date": target_date,
            "kb_filter": json.dumps(list(kb_ids)) if kb_ids else None,
            "triggered_by": triggered_by,
            "triggered_user_id": triggered_user_id,
            "stat_start": stat_start,
            "stat_end": stat_end,
        },
    )
    session.commit()
    return result.lastrowid


def _create_collector_run(
    session: Session, *, run_id: int, domain: str, name: str
) -> int:
    result = session.execute(
        text(
            """
            INSERT INTO kb_stat_collector_runs
                (run_id, domain, collector_name, status, started_at, rows_written)
            VALUES (:run_id, :domain, :name, 'running', NOW(), 0)
        """
        ),
        {"run_id": run_id, "domain": domain, "name": name},
    )
    session.commit()
    return result.lastrowid


def _update_collector_run(
    session: Session,
    collector_run_id: int,
    *,
    status: str,
    rows_written: int = 0,
    duration_ms: int = 0,
    error_message: Optional[str] = None,
) -> None:
    session.execute(
        text(
            """
            UPDATE kb_stat_collector_runs
            SET status = :status, completed_at = NOW(),
                rows_written = :rows_written, duration_ms = :duration_ms,
                error_message = :error_message
            WHERE id = :id
        """
        ),
        {
            "id": collector_run_id,
            "status": status,
            "rows_written": rows_written,
            "duration_ms": duration_ms,
            "error_message": error_message,
        },
    )
    session.commit()


def _finalize_run(
    session: Session,
    *,
    run_id: int,
    status: str,
    metrics_count: int,
    error_message: Optional[str] = None,
) -> None:
    session.execute(
        text(
            """
            UPDATE kb_stat_runs
            SET status = :status, completed_at = NOW(),
                metrics_count = :metrics_count, error_message = :error_message
            WHERE id = :id
        """
        ),
        {
            "id": run_id,
            "status": status,
            "metrics_count": metrics_count,
            "error_message": error_message,
        },
    )
    session.commit()
