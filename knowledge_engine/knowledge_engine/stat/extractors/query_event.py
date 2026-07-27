# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read query events once and materialize parsed fields in the statistics DB."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter

_EXTRACTOR_NAME = "query_event"


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
    return {}


def _as_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalised_query_hash(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalised = " ".join(value.casefold().split())
    if not normalised:
        return None
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


def _parse_event(row: Any, run_id: int) -> dict[str, Any]:
    payload = _as_dict(row.type_data)
    rag = _as_dict(payload.get("rag_result"))
    adoption = _as_dict(payload.get("adoption_result"))
    head = _as_dict(payload.get("kb_head_result"))
    mode = rag.get("injection_mode") or payload.get("injection_mode")
    chunks_count = _as_int(rag.get("chunks_count"))
    cited_count = _as_int(adoption.get("cited_count"))
    event_time: datetime = row.created_at
    return {
        "run_id": run_id,
        "event_id": int(row.id),
        "event_time": event_time,
        "stat_date": event_time.date(),
        "kb_id": _as_int(payload.get("knowledge_id")),
        "user_id": _as_int(row.user_id),
        "injection_mode": str(mode)[:32] if mode is not None else None,
        "is_rag": mode == "rag_retrieval",
        "is_kb_head": bool(
            _as_int(head.get("usage_count"))
            or _as_int(payload.get("kb_head_count"))
            or head.get("document_ids")
        ),
        "chunks_count": chunks_count,
        "retrieval_count": _as_int(rag.get("retrieval_count")),
        "restricted_mode": (
            bool(rag.get("restricted_mode"))
            if rag.get("restricted_mode") is not None
            else None
        ),
        "hit": chunks_count > 0 if chunks_count is not None else None,
        "adopted": cited_count > 0 if cited_count is not None else None,
        "cited_count": cited_count,
        "query_hash": _normalised_query_hash(rag.get("query")),
        "duration_ms": _as_int(rag.get("latency_ms")),
    }


def extract_query_events(
    run_id: int,
    metric_filter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
    batch_size: int = 5000,
) -> int:
    """Extract one date range with keyset pagination and idempotent writes."""
    started = time.monotonic()
    stat_session.execute(
        text(
            """
            INSERT INTO kb_stat_extractor_runs
                (run_id, extractor_name, status, started_at, rows_read,
                 rows_written, batches, duration_ms)
            VALUES (:run_id, :name, 'running', NOW(), 0, 0, 0, 0)
            ON DUPLICATE KEY UPDATE
                status = 'running', started_at = NOW(), completed_at = NULL,
                error_message = NULL
            """
        ),
        {"run_id": run_id, "name": _EXTRACTOR_NAME},
    )
    stat_session.commit()
    cutoff = source_session.execute(
        text(
            """
            SELECT COALESCE(MAX(id), 0)
            FROM subtask_contexts
            WHERE context_type = 'knowledge_base'
              AND created_at >= :start_date
              AND created_at < :end_date
            """
        ),
        {
            "start_date": metric_filter.effective_period_start,
            "end_date": metric_filter.effective_end_date,
        },
    ).scalar()
    cutoff_id = int(cutoff or 0)
    last_id = 0
    rows_read = 0
    rows_written = 0
    batches = 0

    try:
        while last_id < cutoff_id:
            rows = source_session.execute(
                text(
                    """
                    SELECT id, created_at, user_id, type_data
                    FROM subtask_contexts
                    WHERE context_type = 'knowledge_base'
                      AND created_at >= :start_date
                      AND created_at < :end_date
                      AND id > :last_id
                      AND id <= :cutoff_id
                    ORDER BY id
                    LIMIT :batch_size
                    """
                ),
                {
                    "start_date": metric_filter.effective_period_start,
                    "end_date": metric_filter.effective_end_date,
                    "last_id": last_id,
                    "cutoff_id": cutoff_id,
                    "batch_size": batch_size,
                },
            ).fetchall()
            # Release the source-side transaction after every keyset page.
            # Reproducibility comes from the frozen id cutoff, so retaining a
            # long MVCC snapshot only adds pressure to the source replica.
            source_session.commit()
            if not rows:
                break

            events = [_parse_event(row, run_id) for row in rows]
            if metric_filter.kb_ids:
                allowed_kb_ids = set(metric_filter.kb_ids)
                events = [event for event in events if event["kb_id"] in allowed_kb_ids]
            if not events:
                batches += 1
                rows_read += len(rows)
                last_id = int(rows[-1].id)
                continue
            stat_session.execute(
                text(
                    """
                    INSERT INTO kb_stat_stage_query_event
                        (run_id, event_id, event_time, stat_date, kb_id, user_id,
                         injection_mode, is_rag, is_kb_head, chunks_count,
                         retrieval_count, restricted_mode, hit, adopted,
                         cited_count, query_hash, duration_ms)
                    VALUES
                        (:run_id, :event_id, :event_time, :stat_date, :kb_id,
                         :user_id, :injection_mode, :is_rag, :is_kb_head,
                         :chunks_count, :retrieval_count, :restricted_mode,
                         :hit, :adopted, :cited_count, :query_hash, :duration_ms)
                    ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)
                    """
                ),
                events,
            )
            stat_session.commit()
            batches += 1
            rows_read += len(rows)
            rows_written += len(events)
            last_id = int(rows[-1].id)

        duration_ms = int((time.monotonic() - started) * 1000)
        stat_session.execute(
            text(
                """
                UPDATE kb_stat_extractor_runs
                SET status = 'success', completed_at = NOW(),
                    source_cutoff = :cutoff, rows_read = :rows_read,
                    rows_written = :rows_written, batches = :batches,
                    duration_ms = :duration_ms
                WHERE run_id = :run_id AND extractor_name = :name
                """
            ),
            {
                "run_id": run_id,
                "name": _EXTRACTOR_NAME,
                "cutoff": str(cutoff_id),
                "rows_read": rows_read,
                "rows_written": rows_written,
                "batches": batches,
                "duration_ms": duration_ms,
            },
        )
        stat_session.commit()
        return rows_written
    except Exception as exc:
        stat_session.rollback()
        stat_session.execute(
            text(
                """
                UPDATE kb_stat_extractor_runs
                SET status = 'failed', completed_at = NOW(),
                    error_message = :error_message
                WHERE run_id = :run_id AND extractor_name = :name
                """
            ),
            {
                "run_id": run_id,
                "name": _EXTRACTOR_NAME,
                "error_message": str(exc)[:2000],
            },
        )
        stat_session.commit()
        raise
