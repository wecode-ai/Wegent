#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""KB stat test-data manager: seed / clean / status.

Populates deterministic, diverse sample data across every source table the
stat collectors read (kinds / knowledge_documents / subtask_contexts /
resource_members / share_links / dingtalk_synced_nodes / users), with a
multi-day time-series so time-series metrics have real trends. Useful for
frontend integration tuning and collector regression testing.

Usage:
    cd knowledge_engine
    set -a && . ../knowledge_runtime/.env && set +a
    .venv/bin/python ../scripts/kb_stat_test_data.py seed [--kbs 5] [--days 30]
    .venv/bin/python ../scripts/kb_stat_test_data.py clean
    .venv/bin/python ../scripts/kb_stat_test_data.py status
    .venv/bin/python ../scripts/kb_stat_test_data.py seed --trigger-collect

Requires: DATABASE_URL and KNOWLEDGE_STAT_DATABASE_URL env vars (loaded
from knowledge_runtime/.env via the shell snippet above).
"""

import argparse
import json
import os
import random
from datetime import date, datetime, timedelta
from typing import Any, Optional

from sqlalchemy import bindparam, create_engine, text
from sqlalchemy.orm import Session

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TEST_PREFIX = "__test__"
# triggered_by is String(32); keep suffixes short so the value fits.
TRIGGERED_BY_SEED = f"{TEST_PREFIX}seed"  # 11 chars

# Source tables (business DB) that hold test rows, with the column whose
# value carries the TEST_PREFIX. Same coverage as kb_stat_verify.py so
# cleanup is symmetric with the verify script's footprint.
SOURCE_TABLES: list[tuple[str, str]] = [
    ("knowledge_documents", "name"),
    ("kinds", "name"),
    ("subtask_contexts", "name"),
    ("resource_members", "entity_id"),
    ("share_links", "share_token"),
    ("dingtalk_synced_nodes", "dingtalk_node_id"),
    ("knowledge_folders", "name"),
    ("tasks", "name"),
]

# Domains -> the source tables they need. --domain restricts seeding to
# only what a domain's collectors read.
DOMAIN_SOURCE_MAP: dict[str, set[str]] = {
    "retrieval": {"users", "kinds", "subtask_contexts"},
    "content": {"users", "kinds", "knowledge_documents"},
    "collaboration": {"users", "kinds", "resource_members", "share_links"},
    "dashboard": {"users", "kinds", "knowledge_documents", "dingtalk_synced_nodes"},
    "sys_ops": {"users", "kinds", "knowledge_documents", "attachments"},
    "lifecycle": {"users", "kinds", "knowledge_documents"},
    "deep_analysis": {"users", "kinds", "knowledge_documents", "subtask_contexts"},
    "user_behavior": {"users", "kinds", "subtask_contexts", "resource_members"},
    "prometheus": {"users", "kinds", "knowledge_documents"},
}

QUERY_POOL = [
    "如何申请年假",
    "公积金提取条件",
    "报销流程是什么",
    "考勤打卡规则",
    "试用期多长",
    "年假扣减规则",
    "社保缴纳比例",
    "调岗申请流程",
    "绩效考核标准",
    "离职手续办理",
]


# ---------------------------------------------------------------------------
# Engine / session helpers (env resolved lazily so --help works offline)
# ---------------------------------------------------------------------------


def _load_env() -> None:
    env_path = os.path.join(
        os.path.dirname(__file__), "..", "knowledge_runtime", ".env"
    )
    if os.path.exists(env_path):
        try:
            from dotenv import load_dotenv

            load_dotenv(env_path)
        except ImportError:
            pass


def _make_engines() -> tuple[Any, Any]:
    _load_env()
    dsn = os.environ["DATABASE_URL"]
    stat_dsn = os.environ["KNOWLEDGE_STAT_DATABASE_URL"]
    engine = create_engine(dsn, connect_args={"charset": "utf8mb4"})
    stat_engine = create_engine(stat_dsn, connect_args={"charset": "utf8mb4"})
    return engine, stat_engine


def ts(d: date, hour: int = 0) -> datetime:
    return datetime(d.year, d.month, d.day, hour, 0, 0)


def _stat_tables_with_run_id(session: Session) -> list[str]:
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


# ---------------------------------------------------------------------------
# clean
# ---------------------------------------------------------------------------


def clean() -> None:
    print("▶ clean start: removing __test__ data from source + stat DBs")
    engine, stat_engine = _make_engines()
    src = Session(engine)
    stat = Session(stat_engine)
    try:
        # Source tables.
        for table, col in SOURCE_TABLES:
            result = src.execute(
                text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
                {"p": f"{TEST_PREFIX}%"},
            )
            print(f"  [clean] src {table:28s} deleted {result.rowcount}")
        src.commit()

        # Stat tables: find test runs by triggered_by, then delete every
        # kb_stat_* table row for those run_ids (enumerated dynamically).
        test_run_ids = [
            r[0]
            for r in stat.execute(
                text("SELECT id FROM kb_stat_runs WHERE triggered_by LIKE :p"),
                {"p": f"{TEST_PREFIX}%"},
            ).fetchall()
        ]
        print(f"  [clean] stat test runs found: {len(test_run_ids)}")
        if test_run_ids:
            rid_param = bindparam("rids", expanding=True)
            for t in _stat_tables_with_run_id(stat):
                result = stat.execute(
                    text(f"DELETE FROM `{t}` WHERE run_id IN :rids").bindparams(
                        rid_param
                    ),
                    {"rids": test_run_ids},
                )
                if result.rowcount:
                    print(f"  [clean] stat {t:34s} deleted {result.rowcount}")
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
        print(f"✅ clean done: {len(test_run_ids)} stat runs removed")
    finally:
        src.close()
        stat.close()


# ---------------------------------------------------------------------------
# seed
# ---------------------------------------------------------------------------


def seed(
    kbs: int = 5,
    docs: int = 4,
    queries: int = 6,
    days: int = 30,
    target_date: Optional[date] = None,
    domain: Optional[str] = None,
    trigger_collect: bool = False,
    pipeline_mode: str = "legacy",
) -> None:
    random.seed(42)
    target = target_date or date.today()
    period_start = target - timedelta(days=days - 1)

    active_tables: Optional[set[str]] = None
    if domain and domain != "all":
        active_tables = DOMAIN_SOURCE_MAP.get(domain)
        if active_tables is None:
            print(f"❌ unknown domain: {domain}")
            return

    def want(table_key: str) -> bool:
        return active_tables is None or table_key in active_tables

    print(
        f"▶ seed start: kbs={kbs} docs={docs} queries={queries} days={days} "
        f"target={target} domain={domain or 'all'} trigger_collect={trigger_collect} "
        f"pipeline_mode={pipeline_mode}"
    )
    engine, stat_engine = _make_engines()
    src = Session(engine)
    try:
        user_ids = _seed_users(src, 3)
        kb_ids = _seed_kbs(src, user_ids, kbs, period_start, target)
        if want("knowledge_documents"):
            _seed_documents(src, kb_ids, user_ids, docs, period_start, target)
        else:
            print("  [seed] documents:    skipped (--domain)")
        if want("subtask_contexts"):
            _seed_subtask_contexts(src, kb_ids, user_ids, queries, period_start, target)
        else:
            print("  [seed] subtask_ctx:  skipped (--domain)")
        if want("resource_members"):
            _seed_resource_members(src, kb_ids, user_ids)
        else:
            print("  [seed] members:      skipped (--domain)")
        if want("share_links"):
            _seed_share_links(src, kb_ids, user_ids, period_start, target)
        else:
            print("  [seed] share_links:  skipped (--domain)")
        if want("dingtalk_synced_nodes"):
            _seed_dingtalk_nodes(src, user_ids, period_start, target)
        else:
            print("  [seed] dingtalk:     skipped (--domain)")
        if want("attachments"):
            try:
                _seed_attachments(src, kb_ids, user_ids, period_start, target)
            except Exception as e:
                print(f"  [seed] attachments:  skipped (table not available: {e})")
                src.rollback()
        else:
            print("  [seed] attachments:  skipped (--domain)")
        if want("tasks"):
            try:
                _seed_tasks(src, kb_ids, user_ids, period_start, target)
            except Exception as e:
                print(f"  [seed] tasks:        skipped (table not available: {e})")
                src.rollback()
        else:
            print("  [seed] tasks:        skipped (--domain)")
        src.commit()

        total_queries = kbs * queries * days if want("subtask_contexts") else 0
        print(
            f"✅ seed done: {kbs} KBs, docs per KB≈{docs}, "
            f"{total_queries} retrieval records across {days} days"
        )
    finally:
        src.close()

    if trigger_collect:
        print("▶ triggering collection (--trigger-collect)...")
        run_id = _trigger_collection(target, pipeline_mode=pipeline_mode)
        print(f"✅ triggered collection, run_id={run_id}")


def _seed_users(session: Session, n: int) -> list[int]:
    user_ids: list[int] = []
    for i in range(1, n + 1):
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
    print(f"  [seed] users:        {len(user_ids)} rows (ids={user_ids})")
    return user_ids


def _seed_kbs(
    session: Session,
    user_ids: list[int],
    n: int,
    period_start: date,
    target: date,
) -> list[int]:
    """Create N test KBs with diversified retrieval configs (covers
    kb_config_sanity: score_threshold 0/0.3/0.5/0.8, top_k 1/3/5/10)."""
    thresholds = [0, 0.3, 0.5, 0.8]
    top_ks = [1, 3, 5, 10]
    kb_ids: list[int] = []
    for i in range(1, n + 1):
        name = f"{TEST_PREFIX}kb{i}"
        d = period_start + timedelta(days=(i - 1) * max(1, 30 // max(1, n)))
        spec: dict[str, Any] = {
            "summary": {"topics": ["AI", "NLP", "RAG"][: (i % 3) + 1]},
            "retrievalConfig": {
                "mode": "hybrid" if i % 2 == 0 else "vector",
                "score_threshold": thresholds[i % len(thresholds)],
                "top_k": top_ks[i % len(top_ks)],
            },
            "maxCallsPerConversation": 10,
        }
        result = session.execute(
            text(
                "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) "
                "VALUES (:uid, 'KnowledgeBase', :name, 'default', :j, 1, :ca, :ca)"
            ),
            {
                "uid": user_ids[(i - 1) % len(user_ids)],
                "name": name,
                "j": json.dumps({"spec": spec}),
                "ca": ts(d, 10),
            },
        )
        session.commit()
        kb_ids.append(result.lastrowid)
    print(f"  [seed] kbs:          {len(kb_ids)} rows (ids={kb_ids})")
    return kb_ids


def _seed_documents(
    session: Session,
    kb_ids: list[int],
    user_ids: list[int],
    docs_per_kb: int,
    period_start: date,
    target: date,
) -> None:
    extensions = [".pdf", ".docx", ".md", ".xlsx", ".pptx"]
    splitters = ["recursive", "semantic", "fixed"]
    span = (target - period_start).days or 1
    doc_count = 0
    for kb_idx, kb_id in enumerate(kb_ids):
        # KB scale diversity: 3..(docs_per_kb+ kb_idx*2) docs per KB.
        n_docs = max(3, docs_per_kb + (kb_idx % 3) * 2)
        for j in range(1, n_docs + 1):
            name = f"{TEST_PREFIX}doc_kb{kb_idx + 1}_{j}"
            d = period_start + timedelta(days=random.randint(0, span))
            file_size = (kb_idx + 1) * (j + 1) * 1024
            chunk_count = (j % 5) + 1
            splitter = splitters[j % len(splitters)]
            r = random.random()
            if r < 0.80:
                idx_status, is_active = "success", 1
            elif r < 0.95:
                idx_status, is_active = "failed", 0
            else:
                idx_status, is_active = "pending", 0
            session.execute(
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
                    "ia": is_active,
                    "is": idx_status,
                    "ig": 1 if j == 1 else 0,
                    "sc": json.dumps({"splitter_type": splitter}),
                    "chunks": json.dumps(
                        {
                            "splitter_type": splitter,
                            "total_count": chunk_count,
                            "items": [
                                {
                                    "token_count": random.randint(50, 500),
                                    "score": round(random.uniform(0.2, 0.95), 2),
                                }
                                for _ in range(chunk_count)
                            ],
                        }
                    ),
                    "summary": (
                        json.dumps({"status": "completed"}) if j % 2 == 0 else None
                    ),
                    "ca": ts(d, 8 + j % 10),
                },
            )
            doc_count += 1
    session.commit()
    print(f"  [seed] documents:    {doc_count} rows across {len(kb_ids)} KBs")


def _seed_subtask_contexts(
    session: Session,
    kb_ids: list[int],
    user_ids: list[int],
    queries_per_kb: int,
    period_start: date,
    target: date,
) -> None:
    """Per-day retrieval records with a descending zero-chunk trend
    (30% → 10% across the window) and diverse injection modes / latencies.

    A fraction of records have chunks_count=0 so kb_zero_chunk_rate
    and kb_zero_chunk_rate have real zero-hit rows (the verify script's
    chunks_count=j never produced any).
    """
    span = (target - period_start).days or 1
    sc_count = 0
    for day_offset in range(span + 1):
        d = period_start + timedelta(days=day_offset)
        # Zero-chunk probability ramps from 30% down to 10%.
        zero_prob = 0.30 - 0.20 * (day_offset / max(1, span))
        day_count = 0
        for kb_idx, kb_id in enumerate(kb_ids):
            for j in range(1, queries_per_kb + 1):
                name = f"{TEST_PREFIX}q_kb{kb_idx + 1}_d{day_offset}_{j}"
                mode_r = random.random()
                if mode_r < 0.60:
                    injection_mode = "rag_retrieval"
                elif mode_r < 0.80:
                    injection_mode = "direct_injection"
                else:
                    injection_mode = "kb_head"

                # chunks_count: 0 (zero-hit) / 1-5 / 6-10
                if random.random() < zero_prob:
                    chunks_count = 0
                elif mode_r < 0.60:
                    chunks_count = random.randint(1, 5)
                else:
                    chunks_count = random.randint(6, 10)

                latency_ms = random.randint(100, 3000)
                query_text = random.choice(QUERY_POOL)
                kb_head_count = random.randint(0, 3)
                type_data = json.dumps(
                    {
                        "knowledge_id": kb_id,
                        "injection_mode": injection_mode,
                        "rag_result": {
                            "injection_mode": injection_mode,
                            "query": query_text,
                            "chunks_count": chunks_count,
                            "retrieval_count": random.randint(1, 5),
                            "latency_ms": latency_ms,
                            "restricted_mode": random.random() < 0.2,
                        },
                        "adoption_result": {
                            "cited_count": (
                                0 if chunks_count == 0 else random.randint(1, 3)
                            )
                        },
                        "kb_head_result": {
                            "usage_count": kb_head_count,
                            "document_ids": [1] if kb_head_count > 0 else [],
                        },
                        "kb_head_count": kb_head_count,
                    }
                )
                # Build extracted_text with chunk scores for rag_retrieval
                # rows so retrieval_score_distribution has data.
                extracted = ""
                if injection_mode == "rag_retrieval" and chunks_count > 0:
                    extracted = json.dumps(
                        {
                            "chunks": [
                                {
                                    "score": round(random.uniform(0.15, 0.95), 2),
                                    "token_count": random.randint(50, 500),
                                }
                                for _ in range(min(chunks_count, 5))
                            ]
                        }
                    )

                session.execute(
                    text(
                        "INSERT INTO subtask_contexts "
                        "(subtask_id, user_id, context_type, name, status, error_message, "
                        " binary_data, image_base64, extracted_text, text_length, type_data, "
                        " created_at, updated_at) "
                        "VALUES (0, :uid, 'knowledge_base', :name, 'completed', '', "
                        " '', '', :extracted, :tlen, :td, "
                        " :ca, :ca)"
                    ),
                    {
                        "uid": user_ids[(kb_idx + j) % len(user_ids)],
                        "name": name,
                        "extracted": extracted,
                        "tlen": len(extracted),
                        "td": type_data,
                        "ca": ts(d, 9 + j % 12),
                    },
                )
                sc_count += 1
                day_count += 1
        # Per-day progress: date, zero-chunk probability, rows inserted that day.
        print(
            f"  [seed] subtask_ctx  day={d} zero_prob={zero_prob:.2f} +{day_count} (total={sc_count})"
        )
    session.commit()
    print(f"  [seed] subtask_ctx:  {sc_count} rows across {span + 1} days")


def _seed_resource_members(
    session: Session, kb_ids: list[int], user_ids: list[int]
) -> None:
    roles = ["Owner", "Maintainer", "Developer", "Reporter"]
    for kb_idx, kb_id in enumerate(kb_ids):
        for u_idx, uid in enumerate(user_ids):
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
    print(f"  [seed] members:      {len(kb_ids) * len(user_ids)} rows")


def _seed_share_links(
    session: Session,
    kb_ids: list[int],
    user_ids: list[int],
    period_start: date,
    target: date,
) -> None:
    span = (target - period_start).days or 1
    link_count = 0
    for i, kb_id in enumerate(kb_ids[: max(2, len(kb_ids) // 2)]):
        token = f"{TEST_PREFIX}link_{i}_{random.randint(1000,9999)}"
        d = period_start + timedelta(days=random.randint(0, span))
        # expires_at is NOT NULL in share_links; expire 30 days after creation.
        expires = ts(d, 11) + timedelta(days=30)
        session.execute(
            text(
                "INSERT INTO share_links "
                "(resource_type, resource_id, share_token, require_approval, default_role, "
                " expires_at, created_by_user_id, is_active, created_at, updated_at) "
                "VALUES ('KnowledgeBase', :rid, :token, :ap, :role, :exp, :uid, 1, :ca, :ca)"
            ),
            {
                "rid": kb_id,
                "token": token,
                "ap": 1 if i % 2 == 0 else 0,
                "role": "Developer",
                "uid": user_ids[i % len(user_ids)],
                "exp": expires,
                "ca": ts(d, 11),
            },
        )
        link_count += 1
    session.commit()
    print(f"  [seed] share_links:  {link_count} rows")


def _seed_dingtalk_nodes(
    session: Session,
    user_ids: list[int],
    period_start: date,
    target: date,
) -> None:
    span = (target - period_start).days or 1
    dt_count = 0
    for i in range(1, 4):
        node_id = f"{TEST_PREFIX}dt_{i}"
        d = period_start + timedelta(days=random.randint(0, span))
        session.execute(
            text(
                "INSERT INTO dingtalk_synced_nodes "
                "(user_id, dingtalk_node_id, name, doc_url, parent_node_id, node_type, "
                " workspace_id, source, content_type, content_updated_at, is_active, "
                " last_synced_at, created_at, updated_at) "
                "VALUES (:uid, :nid, :name, :url, '', :nt, 'ws1', 'docs', 'doc', :ca, 1, :ca, :ca, :ca)"
            ),
            {
                "uid": user_ids[i % len(user_ids)],
                "nid": node_id,
                "name": f"{TEST_PREFIX} dingtalk node {i}",
                "url": f"https://example.com/{node_id}",
                "nt": "doc",
                "ca": ts(d, 12),
            },
        )
        dt_count += 1
    session.commit()
    print(f"  [seed] dingtalk:     {dt_count} rows")


def _seed_attachments(
    session: Session,
    kb_ids: list[int],
    user_ids: list[int],
    period_start: date,
    target: date,
) -> None:
    """Seed attachments table for sys_ops metrics (attachment_storage,
    doc_index_storage_view)."""
    span = (target - period_start).days or 1
    att_count = 0
    for kb_idx, kb_id in enumerate(kb_ids):
        for j in range(1, 3):  # 2 attachments per KB
            name = f"{TEST_PREFIX}att_kb{kb_idx + 1}_{j}"
            d = period_start + timedelta(days=random.randint(0, span))
            session.execute(
                text(
                    "INSERT INTO attachments "
                    "(kind_id, name, file_extension, file_size, storage_backend, "
                    " status, created_by_user_id, created_at, updated_at) "
                    "VALUES (:kid, :name, :ext, :fsz, :backend, 'active', :uid, :ca, :ca)"
                ),
                {
                    "kid": kb_id,
                    "name": name,
                    "ext": [".pdf", ".docx"][j % 2],
                    "fsz": random.randint(100_000, 5_000_000),
                    "backend": "local" if j % 2 == 0 else "s3",
                    "uid": user_ids[kb_idx % len(user_ids)],
                    "ca": ts(d, 10),
                },
            )
            att_count += 1
    session.commit()
    print(f"  [seed] attachments:  {att_count} rows")


def _seed_tasks(
    session: Session,
    kb_ids: list[int],
    user_ids: list[int],
    period_start: date,
    target: date,
) -> None:
    """Seed tasks table for user_kb_binding metric.
    Each KB gets 1-2 test tasks bound to it."""
    span = (target - period_start).days or 1
    task_count = 0
    for kb_idx, kb_id in enumerate(kb_ids):
        n_tasks = (kb_idx % 2) + 1
        for j in range(n_tasks):
            name = f"{TEST_PREFIX}task_kb{kb_idx + 1}_{j}"
            d = period_start + timedelta(days=random.randint(0, span))
            spec = {
                "knowledge_base_ids": [kb_id],
                "maxCallsPerConversation": 10,
                "retrievalConfig": {
                    "score_threshold": 0.5,
                    "top_k": 5,
                },
            }
            session.execute(
                text(
                    "INSERT INTO tasks "
                    "(user_id, kind, name, namespace, json, is_active, created_at, updated_at) "
                    "VALUES (:uid, 'Task', :name, 'default', :j, 1, :ca, :ca)"
                ),
                {
                    "uid": user_ids[kb_idx % len(user_ids)],
                    "name": name,
                    "j": json.dumps({"spec": spec}),
                    "ca": ts(d, 14),
                },
            )
            task_count += 1
    session.commit()
    print(f"  [seed] tasks:        {task_count} rows")


def _trigger_collection(target: date, *, pipeline_mode: str = "legacy") -> int:
    from knowledge_engine.stat import collect_all, mark_kb_stat_stale_runs
    from shared.db.readonly_session import (
        get_readonly_session_factory,
        init_readonly_db,
    )
    from shared.db.stat_session import get_stat_session_factory, init_stat_db

    print(f"  [collect] initialising DB factories...")
    _load_env()
    init_readonly_db(os.environ["DATABASE_URL"])
    init_stat_db(os.environ["KNOWLEDGE_STAT_DATABASE_URL"])

    # Clean up any stale "running" runs from previous interrupted attempts.
    stat_factory = get_stat_session_factory()
    try:
        cleaned = mark_kb_stat_stale_runs(
            stale_minutes=5, stat_session_factory=stat_factory
        )
        if cleaned:
            print(f"  [collect] cleaned {cleaned} stale running runs")
    except Exception as e:
        print(f"  [collect] stale cleanup warning: {e}")

    print(
        f"  [collect] running collect_all(target={target}, triggered_by={TRIGGERED_BY_SEED})..."
    )
    from knowledge_engine.stat.registry import all_collectors

    print(
        f"  [collect] collectors={len(all_collectors())} "
        f"pipeline_mode={pipeline_mode}"
    )
    run_id = collect_all(
        target_date=target,
        triggered_by=TRIGGERED_BY_SEED,
        pipeline_mode=pipeline_mode,
        source_session_factory=get_readonly_session_factory(),
        stat_session_factory=stat_factory,
    )
    print(f"  [collect] done, run_id={run_id}")
    return run_id


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def status() -> None:
    print("▶ status: querying test-data footprint")
    engine, stat_engine = _make_engines()
    src = Session(engine)
    stat = Session(stat_engine)
    try:
        print("=== Source tables (business DB) ===")
        for table, col in SOURCE_TABLES:
            n = src.execute(
                text(f"SELECT COUNT(*) FROM {table} WHERE {col} LIKE :p"),
                {"p": f"{TEST_PREFIX}%"},
            ).scalar()
            print(f"  {table:30s} {n}")

        print("\n=== Stat tables (stat DB) ===")
        test_runs = stat.execute(
            text("SELECT COUNT(*) FROM kb_stat_runs WHERE triggered_by LIKE :p"),
            {"p": f"{TEST_PREFIX}%"},
        ).scalar()
        print(f"  kb_stat_runs test runs: {test_runs}")
        if test_runs:
            rows = stat.execute(
                text(
                    "SELECT id, target_date, status, triggered_by FROM kb_stat_runs "
                    "WHERE triggered_by LIKE :p ORDER BY id DESC LIMIT 10"
                ),
                {"p": f"{TEST_PREFIX}%"},
            ).fetchall()
            for r in rows:
                print(
                    f"    run #{r.id} target={r.target_date} status={r.status} by={r.triggered_by}"
                )

        print("\n=== Time-series coverage (subtask_contexts) ===")
        span = src.execute(
            text(
                "SELECT MIN(created_at), MAX(created_at), COUNT(*) FROM subtask_contexts "
                "WHERE name LIKE :p"
            ),
            {"p": f"{TEST_PREFIX}%"},
        ).fetchone()
        if span and span[2]:
            print(f"  {span[2]} records, from {span[0]} to {span[1]}")
        else:
            print("  (no test subtask_contexts yet)")

        for table in (
            "kb_stat_extractor_runs",
            "kb_stat_stage_query_event",
            "kb_stat_source_watermarks",
            "kb_stat_metric_watermarks",
        ):
            try:
                count = stat.execute(text(f"SELECT COUNT(*) FROM `{table}`")).scalar()
                print(f"  {table:30s} {count}")
            except Exception:
                stat.rollback()
                print(f"  {table:30s} (not installed)")
    finally:
        src.close()
        stat.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_seed = sub.add_parser("seed", help="populate test data")
    p_seed.add_argument("--kbs", type=int, default=5)
    p_seed.add_argument("--docs", type=int, default=4)
    p_seed.add_argument("--queries", type=int, default=6)
    p_seed.add_argument("--days", type=int, default=30)
    p_seed.add_argument("--target-date", type=_parse_date, default=None)
    p_seed.add_argument(
        "--domain",
        choices=list(DOMAIN_SOURCE_MAP.keys()) + ["all"],
        default="all",
    )
    p_seed.add_argument("--trigger-collect", action="store_true")
    p_seed.add_argument(
        "--pipeline-mode",
        choices=["legacy", "shadow"],
        default="legacy",
    )

    sub.add_parser("clean", help="remove all test data")
    sub.add_parser("status", help="show test-data overview")

    args = parser.parse_args()
    if args.cmd == "seed":
        seed(
            kbs=args.kbs,
            docs=args.docs,
            queries=args.queries,
            days=args.days,
            target_date=args.target_date,
            domain=args.domain,
            trigger_collect=args.trigger_collect,
            pipeline_mode=args.pipeline_mode,
        )
    elif args.cmd == "clean":
        clean()
    elif args.cmd == "status":
        status()


if __name__ == "__main__":
    main()
