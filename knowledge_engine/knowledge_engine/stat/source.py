# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Business database read-only access for stat collectors.

Provides helper queries for KB metadata that collectors need
(kb_id -> namespace/name mapping, etc.).
"""

import logging
from datetime import date
from typing import Optional, Sequence

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter

logger = logging.getLogger(__name__)

# Shared SQL fragments for subtask_contexts JSON parsing (dashboard domain)
RAG_RETRIEVAL_SQL = """
    (JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.rag_result.injection_mode')) = 'rag_retrieval'
     OR (JSON_EXTRACT(sc.type_data, '$.rag_result') IS NULL
         AND JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.injection_mode')) = 'rag_retrieval'))
"""

DIRECT_INJECTION_SQL = """
    (JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.rag_result.injection_mode')) = 'direct_injection'
     OR (JSON_EXTRACT(sc.type_data, '$.rag_result') IS NULL
         AND JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.injection_mode')) = 'direct_injection'))
"""

KB_HEAD_SQL = """
    (JSON_EXTRACT(sc.type_data, '$.kb_head_result.usage_count') > 0
     OR JSON_EXTRACT(sc.type_data, '$.kb_head_count') > 0)
"""


def fetch_kb_metadata(
    source_session: Session,
    kb_ids: Optional[Sequence[int]] = None,
) -> dict[int, tuple[str, str]]:
    """Fetch kb_id -> (namespace, name) mapping from business DB.

    Returns dict mapping kb_id to (namespace, name).
    """
    kb_clause, kb_params = "", {}
    if kb_ids:
        from knowledge_engine.stat.filters import build_kb_in_clause

        kb_clause, kb_params = build_kb_in_clause(kb_ids)
        kb_clause = f"AND id {kb_clause}"

    rows = source_session.execute(
        text(
            f"""
            SELECT id, namespace, name
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
            {kb_clause}
        """
        ),
        kb_params,
    ).fetchall()

    return {r.id: (r.namespace or "", r.name or "") for r in rows}
