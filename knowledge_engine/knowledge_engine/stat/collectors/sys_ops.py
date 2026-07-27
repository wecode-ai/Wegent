# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""System operations domain collectors: storage usage, attachment, index views."""

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 1. storage_usage
# ---------------------------------------------------------------------------


@register_collector(
    domain="sys_ops",
    name="storage_usage",
    description="Per-KB storage usage estimate",
    chart_hint="line",
)
def storage_usage(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND k.id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(
            f"""
            SELECT k.id AS kb_id,
                   k.name AS kb_name,
                   k.namespace,
                   COALESCE(SUM(kd.file_size), 0) AS total_file_size,
                   COUNT(kd.id) AS doc_count
            FROM kinds k
            LEFT JOIN knowledge_documents kd
                ON kd.kind_id = k.id AND kd.is_active = 1
            WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1
              {kb_where}
            GROUP BY k.id, k.name, k.namespace
            ORDER BY total_file_size DESC
        """
        ),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_storage_usage
                    (run_id, target_date, kb_id, kb_name, namespace,
                     total_file_size, doc_count)
                VALUES (:run_id, :target_date, :kb_id, :kb_name, :namespace,
                        :total_file_size, :doc_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "kb_name": r.kb_name,
                "namespace": r.namespace,
                "total_file_size": int(r.total_file_size) if r.total_file_size else 0,
                "doc_count": r.doc_count or 0,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 2. attachment_storage
# ---------------------------------------------------------------------------


@register_collector(
    domain="sys_ops",
    name="attachment_storage",
    description="Attachment storage by backend",
    chart_hint="pie",
)
def attachment_storage(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    try:
        rows = source_session.execute(
            text(
                """
                SELECT JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.storage_backend')) AS storage_backend,
                       COUNT(*) AS file_count,
                       COALESCE(SUM(CAST(JSON_EXTRACT(type_data, '$.file_size') AS SIGNED)), 0) AS total_size
                FROM subtask_contexts
                WHERE context_type = 'attachment'
                  AND type_data IS NOT NULL
                GROUP BY storage_backend
            """
            ),
        ).fetchall()
    except Exception:
        logger.exception("Failed to collect attachment_storage metrics")
        return 0

    written = 0
    for r in rows:
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_attachment_storage
                    (run_id, target_date, storage_backend, file_count, total_size)
                VALUES (:run_id, :target_date, :storage_backend, :file_count, :total_size)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "storage_backend": r.storage_backend,
                "file_count": r.file_count or 0,
                "total_size": int(r.total_size) if r.total_size else 0,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 3. doc_index_storage_view
# ---------------------------------------------------------------------------


@register_collector(
    domain="sys_ops",
    name="doc_index_storage_view",
    description="Index status + storage cross view",
    chart_hint="table",
)
def doc_index_storage_view(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(
            f"""
            SELECT index_status,
                   file_extension,
                   COUNT(*) AS doc_count,
                   COALESCE(SUM(file_size), 0) AS total_file_size,
                   COALESCE(AVG(file_size), 0) AS avg_file_size
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_where}
            GROUP BY index_status, file_extension
        """
        ),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_doc_index_storage_view
                    (run_id, target_date, index_status, file_extension,
                     doc_count, total_file_size, avg_file_size)
                VALUES (:run_id, :target_date, :index_status, :file_extension,
                        :doc_count, :total_file_size, :avg_file_size)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "index_status": r.index_status,
                "file_extension": r.file_extension,
                "doc_count": r.doc_count or 0,
                "total_file_size": int(r.total_file_size) if r.total_file_size else 0,
                "avg_file_size": int(r.avg_file_size) if r.avg_file_size else 0,
            },
        )
        written += 1
    return written
