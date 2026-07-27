#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
KB Stat verification script.

Populates deterministic sample data into source tables, triggers a stat
collection run, then queries stat results and compares against expected
values derived from the same source data.

Usage:
    cd knowledge_engine
    set -a && . ../knowledge_runtime/.env && set +a
    .venv/bin/python ../scripts/kb_stat_verify.py

Requires: DATABASE_URL and KNOWLEDGE_STAT_DATABASE_URL env vars
(defaults to knowledge_runtime .env, loaded above).
"""

import argparse
import json
import os
import random
import sys
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import bindparam, create_engine, text
from sqlalchemy.orm import Session

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Credentials must be provided via environment; never hardcode defaults.
_DSN = os.environ["DATABASE_URL"]
_STAT_DSN = os.environ["KNOWLEDGE_STAT_DATABASE_URL"]

TEST_PREFIX = "__kbstat_test__"
TARGET_DATE = date(2026, 5, 15)
PERIOD_START = TARGET_DATE - timedelta(days=29)
PERIOD_END = TARGET_DATE

NUM_KBS = 5
NUM_DOCS_PER_KB = 4
NUM_QUERIES_PER_KB = 6
NUM_USERS = 3

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

engine = create_engine(_DSN, connect_args={"charset": "utf8mb4"})
stat_engine = create_engine(_STAT_DSN, connect_args={"charset": "utf8mb4"})


def src_session() -> Session:
    return Session(engine)


def stat_session() -> Session:
    return Session(stat_engine)


def ts(d: date, hour: int = 0) -> datetime:
    return datetime(d.year, d.month, d.day, hour, 0, 0)


def _stat_tables_with_run_id(session: Session) -> list[str]:
    """All kb_stat_* tables that have a run_id column.

    Enumerated dynamically via information_schema so newly added stat tables
    are cleaned without editing a hardcoded list.
    """
    rows = session.execute(
        text(
            "SELECT DISTINCT table_name FROM information_schema.columns "
            "WHERE table_schema = DATABASE() "
            "AND table_name LIKE 'kb\\_stat\\_%' "
            "AND column_name = 'run_id' "
            "ORDER BY table_name"
        )
    ).fetchall()
    return [r[0] for r in rows]


def cleanup(src: Session, stat: Session) -> None:
    """Remove all test data from previous runs.

    Source tables live in the business DB (``src``); stat tables live in the
    stat DB (``stat``). The old cleanup used a single session for both, so
    when the stat DB differed from the source DB the stat-table deletes
    silently no-op'd (swallowed by try/except) and test rows leaked into 60+
    stat tables, polluting subsequent runs. Each side is now cleaned with its
    own session, and stat tables are enumerated dynamically so every
    kb_stat_* table is covered rather than a hardcoded five.
    """
    # --- source tables (business DB) ---
    for table, col in [
        ("knowledge_documents", "name"),
        ("kinds", "name"),
        ("subtask_contexts", "name"),
        ("resource_members", "entity_id"),
        ("share_links", "share_token"),
        ("dingtalk_synced_nodes", "dingtalk_node_id"),
        ("knowledge_folders", "name"),
        ("tasks", "name"),
    ]:
        src.execute(
            text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
            {"p": f"{TEST_PREFIX}%"},
        )
    src.commit()

    # --- stat tables (stat DB) ---
    test_run_ids = [
        r[0]
        for r in stat.execute(
            text("SELECT id FROM kb_stat_runs WHERE triggered_by LIKE :p"),
            {"p": f"{TEST_PREFIX}%"},
        ).fetchall()
    ]
    if test_run_ids:
        rid_param = bindparam("rids", expanding=True)
        for t in _stat_tables_with_run_id(stat):
            stat.execute(
                text(f"DELETE FROM `{t}` WHERE run_id IN :rids").bindparams(rid_param),
                {"rids": test_run_ids},
            )
    # kb_stat_collector_runs has run_id (covered above) but kept explicit for
    # clarity; kb_stat_runs itself has no run_id column.
    stat.execute(
        text(
            "DELETE FROM kb_stat_collector_runs WHERE run_id IN "
            "(SELECT id FROM kb_stat_runs WHERE triggered_by LIKE :p)"
        ),
        {"p": f"{TEST_PREFIX}%"},
    )
    stat.execute(
        text("DELETE FROM kb_stat_runs WHERE triggered_by LIKE :p"),
        {"p": f"{TEST_PREFIX}%"},
    )
    stat.commit()


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------


def seed_users(session: Session) -> list[int]:
    """Ensure test users exist, return user IDs."""
    user_ids = []
    for i in range(1, NUM_USERS + 1):
        name = f"{TEST_PREFIX}user{i}"
        row = session.execute(
            text("SELECT id FROM users WHERE user_name = :n"), {"n": name}
        ).fetchone()
        if row:
            user_ids.append(row.id)
        else:
            result = session.execute(
                text(
                    "INSERT INTO users (user_name, password_hash, email, is_active, role, auth_source, preferences, created_at, updated_at) "
                    "VALUES (:n, '', :e, 1, 'user', 'local', '', NOW(), NOW())"
                ),
                {"n": name, "e": f"{name}@test.com"},
            )
            session.commit()
            user_ids.append(result.lastrowid)
    return user_ids


def seed_kbs(session: Session, user_ids: list[int]) -> list[int]:
    """Insert test knowledge bases, return KB IDs."""
    kb_ids = []
    for i in range(1, NUM_KBS + 1):
        name = f"{TEST_PREFIX}kb{i}"
        # Stagger creation dates across the period
        d = PERIOD_START + timedelta(days=(i - 1) * 7)
        topics = json.dumps(["AI", "NLP", "RAG"][:i])
        result = session.execute(
            text(
                "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) "
                "VALUES (:uid, 'KnowledgeBase', :name, 'default', :j, 1, :ca, :ca)"
            ),
            {
                "uid": user_ids[(i - 1) % len(user_ids)],
                "name": name,
                "j": json.dumps(
                    {
                        "spec": {
                            "summary": {"topics": ["AI", "NLP", "RAG"][:i]},
                            "retrievalConfig": {"mode": "hybrid"} if i % 2 == 0 else {},
                        }
                    }
                ),
                "ca": ts(d, 10),
            },
        )
        session.commit()
        kb_ids.append(result.lastrowid)
    return kb_ids


def seed_docs(session: Session, kb_ids: list[int], user_ids: list[int]) -> list[int]:
    """Insert test documents, return doc IDs."""
    doc_ids = []
    extensions = [".pdf", ".docx", ".txt", ".md"]
    for kb_idx, kb_id in enumerate(kb_ids):
        for j in range(1, NUM_DOCS_PER_KB + 1):
            name = f"{TEST_PREFIX}doc_kb{kb_idx+1}_{j}"
            d = PERIOD_START + timedelta(days=random.randint(0, 29))
            file_size = (kb_idx + 1) * (j + 1) * 1024  # predictable sizes
            chunk_count = (j % 3) + 1
            splitter_type = ["recursive", "semantic", "fixed"][j % 3]
            idx_status = (
                "success" if j <= 3 else ("failed" if j == 4 else "not_indexed")
            )
            result = session.execute(
                text(
                    "INSERT INTO knowledge_documents "
                    "(kind_id, attachment_id, name, file_extension, file_size, status, user_id, "
                    " is_active, index_status, index_generation, splitter_config, source_type, "
                    " source_config, chunks, summary, folder_id, created_at, updated_at) "
                    "VALUES (:kid, 0, :name, :ext, :fsz, 'enabled', :uid, "
                    " :ia, :is, :ig, :sc, 'file', "
                    " '{}', :chunks, :summary, 0, :ca, :ca)"
                ),
                {
                    "kid": kb_id,
                    "name": name,
                    "ext": extensions[j % len(extensions)],
                    "fsz": file_size,
                    "uid": user_ids[(kb_idx + j) % len(user_ids)],
                    "ia": 1 if idx_status == "success" else 0,
                    "is": idx_status,
                    "ig": 1 if j == 1 else 0,
                    "sc": json.dumps({"splitter_type": splitter_type}),
                    "chunks": json.dumps(
                        {"splitter_type": splitter_type, "total_count": chunk_count}
                    ),
                    "summary": json.dumps({"topics": ["topic1"]}) if j == 1 else None,
                    "ca": ts(d, 8 + j),
                },
            )
            session.commit()
            doc_ids.append(result.lastrowid)
    return doc_ids


def seed_subtask_contexts(
    session: Session, kb_ids: list[int], user_ids: list[int]
) -> list[int]:
    """Insert test subtask_contexts (RAG/head queries), return IDs."""
    sc_ids = []
    modes = ["rag_retrieval", "direct_injection", "rag_retrieval"]
    for kb_idx, kb_id in enumerate(kb_ids):
        for j in range(1, NUM_QUERIES_PER_KB + 1):
            name = f"{TEST_PREFIX}query_kb{kb_idx+1}_{j}"
            d = PERIOD_START + timedelta(days=random.randint(0, 29))
            injection_mode = modes[j % len(modes)]
            kb_head_count = j % 3
            type_data = json.dumps(
                {
                    "knowledge_id": kb_id,
                    "injection_mode": injection_mode,
                    "rag_result": {
                        "injection_mode": injection_mode,
                        "query": f"test query {j}",
                        "chunks_count": j,
                        "retrieval_count": 1,
                    },
                    "kb_head_result": {
                        "usage_count": kb_head_count,
                        "document_ids": [1] if kb_head_count > 0 else [],
                    },
                    "kb_head_count": kb_head_count,
                }
            )
            result = session.execute(
                text(
                    "INSERT INTO subtask_contexts "
                    "(subtask_id, user_id, context_type, name, status, error_message, "
                    " binary_data, image_base64, extracted_text, text_length, type_data, "
                    " created_at, updated_at) "
                    "VALUES (0, :uid, 'knowledge_base', :name, 'completed', '', "
                    " '', '', '', 0, :td, "
                    " :ca, :ca)"
                ),
                {
                    "uid": user_ids[(kb_idx + j) % len(user_ids)],
                    "name": name,
                    "td": type_data,
                    "ca": ts(d, 9 + j % 12),
                },
            )
            session.commit()
            sc_ids.append(result.lastrowid)
    return sc_ids


def seed_resource_members(
    session: Session, kb_ids: list[int], user_ids: list[int]
) -> None:
    """Insert test resource members for KBs."""
    roles = ["Owner", "Maintainer", "Developer", "Reporter"]
    for kb_idx, kb_id in enumerate(kb_ids):
        for u_idx, uid in enumerate(user_ids):
            name = f"{TEST_PREFIX}member_kb{kb_idx+1}_u{uid}"
            session.execute(
                text(
                    "INSERT INTO resource_members "
                    "(resource_type, resource_id, entity_type, entity_id, entity_display_name, user_id, "
                    " role, status, invited_by_user_id, requested_at, created_at, updated_at) "
                    "VALUES ('KnowledgeBase', :rid, 'user', :eid, :eid, :uid, "
                    " :role, 'approved', 0, NOW(), NOW(), NOW())"
                ),
                {
                    "rid": kb_id,
                    "eid": str(uid),
                    "uid": uid,
                    "role": roles[u_idx % len(roles)],
                },
            )
    session.commit()


# ---------------------------------------------------------------------------
# Run collection
# ---------------------------------------------------------------------------


def trigger_collection(pipeline_mode: str = "legacy") -> int:
    """Trigger stat collection via the Celery task and return run_id."""
    from knowledge_engine.stat import collect_all
    from shared.db.readonly_session import get_readonly_session_factory
    from shared.db.stat_session import get_stat_session_factory

    run_id = collect_all(
        target_date=TARGET_DATE,
        triggered_by=f"{TEST_PREFIX}verify",
        pipeline_mode=pipeline_mode,
        source_session_factory=get_readonly_session_factory(),
        stat_session_factory=get_stat_session_factory(),
    )
    return run_id


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


class Verifier:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.results: list[tuple[str, bool, str]] = []

    def check(self, name: str, actual: Any, expected: Any) -> None:
        ok = actual == expected
        if ok:
            self.passed += 1
            self.results.append((name, True, ""))
        else:
            self.failed += 1
            self.results.append((name, False, f"expected={expected}, actual={actual}"))

    def pass_info(self, name: str, detail: str = "") -> None:
        """Record a passing check with an informational detail string.

        Used for the 81-metric coverage sweep where every metric is queried
        and its row count reported — a PASS with rows=N is more useful than
        a bare PASS.
        """
        self.passed += 1
        self.results.append((name, True, detail))

    def report(self) -> bool:
        print("\n" + "=" * 60)
        print("KB Stat Verification Results")
        print("=" * 60)
        for name, ok, detail in self.results:
            status = "PASS" if ok else "FAIL"
            line = f"  [{status}] {name}"
            if detail:
                line += f"  ({detail})"
            print(line)
        print("-" * 60)
        print(
            f"  Total: {self.passed + self.failed}  Passed: {self.passed}  Failed: {self.failed}"
        )
        print("=" * 60)
        return self.failed == 0


def compute_expected(session: Session) -> dict:
    """Compute expected stat values directly from source tables."""
    # Global totals
    kb_count = session.execute(
        text(
            "SELECT COUNT(*) FROM kinds WHERE kind='KnowledgeBase' AND is_active=1 AND name LIKE :p"
        ),
        {"p": f"{TEST_PREFIX}%"},
    ).scalar()

    doc_count = session.execute(
        text(
            "SELECT COUNT(*) FROM knowledge_documents WHERE is_active=1 AND name LIKE :p"
        ),
        {"p": f"{TEST_PREFIX}%"},
    ).scalar()

    total_storage = (
        session.execute(
            text(
                "SELECT COALESCE(SUM(file_size),0) FROM knowledge_documents WHERE is_active=1 AND name LIKE :p"
            ),
            {"p": f"{TEST_PREFIX}%"},
        ).scalar()
        or 0
    )

    # Period totals - queries
    period_queries = session.execute(
        text(
            "SELECT COUNT(*) FROM subtask_contexts "
            "WHERE context_type='knowledge_base' AND name LIKE :p "
            "AND created_at >= :s AND created_at <= :e"
        ),
        {"p": f"{TEST_PREFIX}%", "s": PERIOD_START, "e": PERIOD_END},
    ).scalar()

    # RAG queries
    rag_queries = session.execute(
        text(
            "SELECT COUNT(*) FROM subtask_contexts sc "
            "WHERE sc.context_type='knowledge_base' AND sc.name LIKE :p "
            "AND sc.created_at >= :s AND sc.created_at <= :e "
            "AND (JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.rag_result.injection_mode')) = 'rag_retrieval' "
            "     OR (JSON_EXTRACT(sc.type_data, '$.rag_result') IS NULL "
            "         AND JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.injection_mode')) = 'rag_retrieval'))"
        ),
        {"p": f"{TEST_PREFIX}%", "s": PERIOD_START, "e": PERIOD_END},
    ).scalar()

    # Direct injection
    direct_inject = session.execute(
        text(
            "SELECT COUNT(*) FROM subtask_contexts sc "
            "WHERE sc.context_type='knowledge_base' AND sc.name LIKE :p "
            "AND sc.created_at >= :s AND sc.created_at <= :e "
            "AND (JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.rag_result.injection_mode')) = 'direct_injection' "
            "     OR (JSON_EXTRACT(sc.type_data, '$.rag_result') IS NULL "
            "         AND JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.injection_mode')) = 'direct_injection'))"
        ),
        {"p": f"{TEST_PREFIX}%", "s": PERIOD_START, "e": PERIOD_END},
    ).scalar()

    # KB head queries
    kb_head_queries = session.execute(
        text(
            "SELECT COUNT(*) FROM subtask_contexts sc "
            "WHERE sc.context_type='knowledge_base' AND sc.name LIKE :p "
            "AND sc.created_at >= :s AND sc.created_at <= :e "
            "AND (JSON_EXTRACT(sc.type_data, '$.kb_head_result.usage_count') > 0 "
            "     OR JSON_EXTRACT(sc.type_data, '$.kb_head_count') > 0)"
        ),
        {"p": f"{TEST_PREFIX}%", "s": PERIOD_START, "e": PERIOD_END},
    ).scalar()

    # New KBs in period
    new_kb = session.execute(
        text(
            "SELECT COUNT(*) FROM kinds "
            "WHERE kind='KnowledgeBase' AND is_active=1 AND name LIKE :p "
            "AND created_at >= :s AND created_at <= :e"
        ),
        {"p": f"{TEST_PREFIX}%", "s": PERIOD_START, "e": PERIOD_END},
    ).scalar()

    # New docs in period
    new_docs = session.execute(
        text(
            "SELECT COUNT(*) FROM knowledge_documents "
            "WHERE name LIKE :p AND created_at >= :s AND created_at <= :e"
        ),
        {"p": f"{TEST_PREFIX}%", "s": PERIOD_START, "e": PERIOD_END},
    ).scalar()

    # Storage per KB
    storage_per_kb = {}
    rows = session.execute(
        text(
            "SELECT k.id, COALESCE(SUM(kd.file_size),0) AS total "
            "FROM kinds k LEFT JOIN knowledge_documents kd ON kd.kind_id=k.id AND kd.is_active=1 "
            "WHERE k.kind='KnowledgeBase' AND k.is_active=1 AND k.name LIKE :p "
            "GROUP BY k.id"
        ),
        {"p": f"{TEST_PREFIX}%"},
    ).fetchall()
    for r in rows:
        storage_per_kb[r.id] = int(r.total)

    # Health score per KB — mirrors the kb_health_score collector exactly:
    # activity 0.3 + index_success 0.3 + enable 0.2 + summary 0.2, each a
    # 0-100 percentage over the KB's documents. effective_end_date is
    # target_date + 1 day (see MetricFilter.effective_end_date), matching
    # the collector's DATE_SUB(:end_date, INTERVAL 30 DAY) window.
    health_per_kb: dict[int, Any] = {}
    health_rows = session.execute(
        text(
            "SELECT k.id AS kb_id, "
            "COUNT(kd.id) AS total, "
            "SUM(CASE WHEN kd.updated_at >= DATE_SUB(:end_date, INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS active, "
            "SUM(CASE WHEN kd.index_status = 'success' THEN 1 ELSE 0 END) AS success, "
            "SUM(CASE WHEN kd.is_active = 1 THEN 1 ELSE 0 END) AS enabled, "
            "SUM(CASE WHEN kd.summary IS NOT NULL AND JSON_LENGTH(kd.summary) > 0 THEN 1 ELSE 0 END) AS summary "
            "FROM kinds k LEFT JOIN knowledge_documents kd ON kd.kind_id = k.id "
            "WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1 AND k.name LIKE :p "
            "GROUP BY k.id"
        ),
        {"p": f"{TEST_PREFIX}%", "end_date": TARGET_DATE + timedelta(days=1)},
    ).fetchall()
    for r in health_rows:
        total = int(r.total or 0)
        if total == 0:
            # Empty KB -> NULL (collector distinguishes "no data" from "unhealthy").
            health_per_kb[r.kb_id] = None
        else:
            act = round(float(r.active or 0) / total * 100, 2)
            idx = round(float(r.success or 0) / total * 100, 2)
            en = round(float(r.enabled or 0) / total * 100, 2)
            sm = round(float(r.summary or 0) / total * 100, 2)
            health_per_kb[r.kb_id] = round(
                act * 0.3 + idx * 0.3 + en * 0.2 + sm * 0.2, 2
            )

    return {
        "kb_count": kb_count,
        "doc_count": doc_count,
        "total_storage": int(total_storage),
        "period_total_queries": period_queries,
        "period_rag_queries": rag_queries,
        "period_direct_inject": direct_inject,
        "period_kb_head_queries": kb_head_queries,
        "period_new_kb": new_kb,
        "period_new_docs": new_docs,
        "storage_per_kb": storage_per_kb,
        "health_per_kb": health_per_kb,
    }


def verify(run_id: int, expected: dict) -> bool:
    """Query stat tables and compare against expected values."""
    v = Verifier()
    session = stat_session()

    try:
        # -- Global totals --
        gt = session.execute(
            text("SELECT * FROM kb_stat_global_totals WHERE run_id = :rid"),
            {"rid": run_id},
        ).fetchone()

        if gt:
            v.check(
                "global_totals.total_kb_count >= test_kbs",
                gt.total_kb_count >= expected["kb_count"],
                True,
            )
            v.check(
                "global_totals.total_doc_count >= test_docs",
                gt.total_doc_count >= expected["doc_count"],
                True,
            )
        else:
            v.check("global_totals row exists", False, True)

        # -- Total storage from storage_usage --
        total_storage = (
            session.execute(
                text(
                    "SELECT COALESCE(SUM(total_file_size),0) FROM kb_stat_storage_usage WHERE run_id = :rid"
                ),
                {"rid": run_id},
            ).scalar()
            or 0
        )
        v.check(
            "total_storage >= expected",
            int(total_storage) >= expected["total_storage"],
            True,
        )

        # -- Storage per KB --
        if expected["storage_per_kb"]:
            storage_stmt = text(
                "SELECT kb_id, total_file_size FROM kb_stat_storage_usage "
                "WHERE run_id = :rid AND kb_id IN :kbids"
            ).bindparams(bindparam("kbids", expanding=True))
            storage_rows = session.execute(
                storage_stmt,
                {"rid": run_id, "kbids": list(expected["storage_per_kb"].keys())},
            ).fetchall()
        else:
            storage_rows = []

        for r in storage_rows:
            exp = expected["storage_per_kb"].get(r.kb_id, -1)
            v.check(f"storage_usage.kb_id={r.kb_id}", int(r.total_file_size), exp)

        # -- Period totals --
        pt = session.execute(
            text(
                "SELECT * FROM kb_stat_period_totals WHERE run_id = :rid ORDER BY id DESC LIMIT 1"
            ),
            {"rid": run_id},
        ).fetchone()

        if pt:
            # Counts include test data plus any pre-existing data, so check >=
            v.check(
                "period_totals.total_queries >= expected",
                pt.period_total_queries >= expected["period_total_queries"],
                True,
            )
            v.check(
                "period_totals.rag_queries >= expected",
                pt.period_rag_queries >= expected["period_rag_queries"],
                True,
            )
            v.check(
                "period_totals.direct_inject >= expected",
                pt.period_direct_inject >= expected["period_direct_inject"],
                True,
            )
            v.check(
                "period_totals.kb_head_queries >= expected",
                pt.period_kb_head_queries >= expected["period_kb_head_queries"],
                True,
            )
            v.check(
                "period_totals.new_kb >= expected",
                pt.period_new_kb >= expected["period_new_kb"],
                True,
            )
            v.check(
                "period_totals.new_docs >= expected",
                pt.period_new_docs >= expected["period_new_docs"],
                True,
            )
        else:
            v.check("period_totals row exists", False, True)

        # -- Daily dashboard --
        daily_count = session.execute(
            text("SELECT COUNT(*) FROM kb_stat_daily_dashboard WHERE run_id = :rid"),
            {"rid": run_id},
        ).scalar()
        v.check("daily_dashboard has rows", daily_count > 0, True)

        # -- Run status --
        run_row = session.execute(
            text("SELECT status, metrics_count FROM kb_stat_runs WHERE id = :rid"),
            {"rid": run_id},
        ).fetchone()
        if run_row:
            v.check(
                "run status is completed or partial",
                run_row.status in ("completed", "partial"),
                True,
            )
            v.check("run metrics_count > 0", run_row.metrics_count > 0, True)
        else:
            v.check("run row exists", False, True)

        # -- Collector runs --
        collector_count = session.execute(
            text("SELECT COUNT(*) FROM kb_stat_collector_runs WHERE run_id = :rid"),
            {"rid": run_id},
        ).scalar()
        v.check("collector_runs exist", collector_count > 0, True)

        failed_collectors = session.execute(
            text(
                "SELECT collector_name, error_message FROM kb_stat_collector_runs "
                "WHERE run_id = :rid AND status = 'failed'"
            ),
            {"rid": run_id},
        ).fetchall()
        for fc in failed_collectors:
            v.check(f"collector {fc.collector_name} succeeded", False, True)

        # -- Storage usage rows --
        storage_count = session.execute(
            text("SELECT COUNT(*) FROM kb_stat_storage_usage WHERE run_id = :rid"),
            {"rid": run_id},
        ).scalar()
        v.check(
            "storage_usage rows match KB count",
            storage_count >= expected["kb_count"],
            True,
        )

        # -- KB health score (P3 metric, weighted: 0.3/0.3/0.2/0.2) --
        # collect_all runs without a kb_ids filter, so kb_stat_kb_health_score
        # holds rows for every KB in the platform — not just the test KBs.
        # Scope the assertion to the test KB ids (expected only covers them),
        # mirroring how storage_usage is checked above.
        if expected["health_per_kb"]:
            health_stmt = text(
                "SELECT kb_id, health_score FROM kb_stat_kb_health_score "
                "WHERE run_id = :rid AND kb_id IN :kbids"
            ).bindparams(bindparam("kbids", expanding=True))
            health_rows = session.execute(
                health_stmt,
                {
                    "rid": run_id,
                    "kbids": list(expected["health_per_kb"].keys()),
                },
            ).fetchall()
        else:
            health_rows = []
        v.check(
            "health_score rows match KB count",
            len(health_rows) >= expected["kb_count"],
            True,
        )
        for r in health_rows:
            exp = expected["health_per_kb"].get(r.kb_id)
            v.check(f"health_score.kb_id={r.kb_id}", r.health_score, exp)

        # -- Full metric coverage: every MetricSpec must map to a queryable
        # stat table with a run_id slice for this run. This is the structural
        # guarantee that no collector/metric regressed silently. Row count is
        # reported per metric; zero is legitimate (a collector may find no
        # data for the seeded fixtures), so the assertion is "table queryable
        # for this run_id", not "rows > 0". --
        from knowledge_engine.stat.metric_spec import _METRIC_SPECS

        for name, spec in _METRIC_SPECS.items():
            try:
                cnt = session.execute(
                    text(f"SELECT COUNT(*) FROM `{spec.table}` WHERE run_id = :rid"),
                    {"rid": run_id},
                ).scalar()
                v.pass_info(f"metric {name} queryable", f"rows={cnt}")
            except Exception as e:  # noqa: BLE001 - surface as a failed check
                v.check(f"metric {name} queryable", False, True)
                v.results[-1] = (f"metric {name} queryable", False, f"err={e}")

    finally:
        session.close()

    return v.report()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="KB Stat verification script")
    parser.add_argument(
        "--no-cleanup", action="store_true", help="Keep test data after verification"
    )
    parser.add_argument(
        "--cleanup-only",
        action="store_true",
        help="Only clean up test data, skip seeding and verification",
    )
    parser.add_argument(
        "--pipeline-mode",
        choices=["legacy", "shadow"],
        default="legacy",
        help="Run legacy collectors or also exercise the statistics staging extractor",
    )
    args = parser.parse_args()

    random.seed(42)  # deterministic

    print("1. Cleaning up old test data...")
    s = src_session()
    st = stat_session()
    try:
        cleanup(s, st)
    finally:
        s.close()
        st.close()

    if args.cleanup_only:
        print("Done.")
        sys.exit(0)

    print("2. Seeding source data...")
    s = src_session()
    try:
        user_ids = seed_users(s)
        print(f"   Users: {user_ids}")
        kb_ids = seed_kbs(s, user_ids)
        print(f"   KBs: {kb_ids}")
        doc_ids = seed_docs(s, kb_ids, user_ids)
        print(f"   Docs: {len(doc_ids)}")
        sc_ids = seed_subtask_contexts(s, kb_ids, user_ids)
        print(f"   Queries: {len(sc_ids)}")
        seed_resource_members(s, kb_ids, user_ids)
        print(f"   Members: {len(kb_ids) * len(user_ids)}")
    finally:
        s.close()

    print("3. Computing expected values from source tables...")
    s = src_session()
    try:
        expected = compute_expected(s)
    finally:
        s.close()
    print(
        f"   Expected: kb_count={expected['kb_count']}, doc_count={expected['doc_count']}, "
        f"total_storage={expected['total_storage']}, queries={expected['period_total_queries']}, "
        f"rag={expected['period_rag_queries']}, direct={expected['period_direct_inject']}, "
        f"kb_head={expected['period_kb_head_queries']}, new_kb={expected['period_new_kb']}, "
        f"new_docs={expected['period_new_docs']}"
    )
    print(f"   Expected health_per_kb={expected['health_per_kb']}")

    print("4. Running stat collection...")
    # Init DB sessions for knowledge_engine
    from shared.db.readonly_session import init_readonly_db
    from shared.db.stat_session import init_stat_db

    init_stat_db(_STAT_DSN)
    init_readonly_db(_DSN)

    run_id = trigger_collection(args.pipeline_mode)
    print(f"   Run ID: {run_id}")

    print("5. Verifying stat results...")
    success = verify(run_id, expected)

    if not success:
        print("\nVerification FAILED. Leaving test data for inspection.")
        sys.exit(1)
    elif args.no_cleanup:
        print("\nVerification PASSED. Test data kept (--no-cleanup).")
        sys.exit(0)
    else:
        print("\nVerification PASSED. Cleaning up test data...")
        s = src_session()
        st = stat_session()
        try:
            cleanup(s, st)
        finally:
            s.close()
            st.close()
        print("Done.")
        sys.exit(0)


if __name__ == "__main__":
    main()
