#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""为指定知识库灌入完整的检索测试数据，覆盖所有统计表的源数据需求。

Usage:
    cd knowledge_engine
    set -a && . ../knowledge_runtime/.env && set +a
    .venv/bin/python ../scripts/kb_stat_seed_kb.py seed --kb-id 148 --days 30
    # 灌完后立即触发该 KB 的采集，详情页即可直接看到数据：
    .venv/bin/python ../scripts/kb_stat_seed_kb.py seed --kb-id 148 --days 30 --trigger-collect
"""

import argparse
import json
import os
import random
from datetime import date, datetime, timedelta

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

TEST_PREFIX = "__test__"
# triggered_by is String(32); __test__ prefix lets clean_kb remove these runs.
TRIGGERED_BY = f"{TEST_PREFIX}seed_kb"
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
    "合同续签流程",
    "加班补偿标准",
]


def ts(d: date, hour: int = 0) -> datetime:
    return datetime(d.year, d.month, d.day, hour, 0, 0)


def seed_kb(
    kb_id: int,
    days: int = 30,
    queries_per_day: int = 15,
    target_date=None,
    trigger_collect: bool = False,
):
    random.seed(42)
    target = target_date or date.today()
    period_start = target - timedelta(days=days - 1)

    load_dotenv(
        os.path.join(os.path.dirname(__file__), "..", "knowledge_runtime", ".env")
    )
    url = os.environ["DATABASE_URL"]
    engine = create_engine(url, connect_args={"charset": "utf8mb4"})
    src = Session(engine)

    # 1. 获取 KB 信息和已有用户
    kb = src.execute(
        text("SELECT id, name, namespace, user_id FROM kinds WHERE id=:id"),
        {"id": kb_id},
    ).fetchone()
    if not kb:
        print(f"❌ KB {kb_id} not found")
        return

    # 获取 KB 的文档
    docs = src.execute(
        text(
            "SELECT id, name, file_extension FROM knowledge_documents "
            "WHERE kind_id=:kid AND is_active=1"
        ),
        {"kid": kb_id},
    ).fetchall()
    print(f"KB: {kb.name} (id={kb_id}) docs={len(docs)}")

    # 获取用户列表
    users = src.execute(
        text("SELECT id FROM users WHERE is_active=1 LIMIT 10")
    ).fetchall()
    user_ids = [u.id for u in users]
    if not user_ids:
        # 创建测试用户
        for i in range(1, 4):
            result = src.execute(
                text(
                    "INSERT INTO users (user_name, password_hash, email, is_active, role, auth_source, preferences, created_at, updated_at) "
                    "VALUES (:n, '', :e, 1, 'user', 'local', '', NOW(), NOW())"
                ),
                {"n": f"{TEST_PREFIX}user{i}", "e": f"{TEST_PREFIX}user{i}@test.com"},
            )
            src.commit()
            user_ids.append(result.lastrowid)
    print(f"Users: {user_ids}")

    # 0. 预清理该 KB 的旧测试数据，保证 seed 可重复运行（幂等）
    # subtask_contexts / tasks 可重复插入（无唯一约束），但 share_links
    # 的 share_token 和 resource_members 的 (resource,id,entity) 有唯一约束。
    for table, col, pattern in [
        ("subtask_contexts", "name", f"{TEST_PREFIX}sc_kb{kb_id}_%"),
        ("knowledge_documents", "name", f"{TEST_PREFIX}doc_kb{kb_id}_%"),
        ("share_links", "share_token", f"{TEST_PREFIX}kb{kb_id}_link_%"),
        ("tasks", "name", f"{TEST_PREFIX}task_kb{kb_id}_%"),
    ]:
        try:
            src.execute(
                text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
                {"p": pattern},
            )
        except Exception:
            src.rollback()
    src.commit()

    # 1.5 灌入 knowledge_documents（覆盖 doc_upload_trend / kb_growth_curve /
    # kb_size_distribution）。分散 created_at 到周期内多天，含 file_extension /
    # source_type / user_id，is_active=1。
    extensions = [".pdf", ".docx", ".md", ".xlsx", ".pptx"]
    span = (target - period_start).days or 1
    doc_count = 0
    for j in range(1, 9):
        name = f"{TEST_PREFIX}doc_kb{kb_id}_{j}"
        d = period_start + timedelta(days=random.randint(0, span))
        file_size = (j + 1) * 1024
        chunk_count = (j % 5) + 1
        src.execute(
            text(
                "INSERT INTO knowledge_documents "
                "(kind_id, attachment_id, name, file_extension, file_size, status, user_id, "
                " is_active, index_status, index_generation, splitter_config, source_type, "
                " source_config, chunks, summary, folder_id, created_at, updated_at) "
                "VALUES (:kid, 0, :name, :ext, :fsz, 'enabled', :uid, "
                " 1, 'success', 1, :sc, 'file', '{}', :chunks, :summary, 0, :ca, :ca)"
            ),
            {
                "kid": kb_id,
                "name": name,
                "ext": extensions[j % len(extensions)],
                "fsz": file_size,
                "uid": user_ids[j % len(user_ids)],
                # splitter_config must be a valid SplitterConfig shape (the
                # response schema's normalize_splitter_config reads the "type"
                # key, not "splitter_type"). Empty {} normalizes to the default
                # flat config; chunks.splitter_type below feeds doc_chunk_strategy.
                "sc": "{}",
                "chunks": json.dumps(
                    {
                        "splitter_type": "recursive",
                        "total_count": chunk_count,
                        "items": [
                            {"token_count": random.randint(50, 500)}
                            for _ in range(chunk_count)
                        ],
                    }
                ),
                "summary": json.dumps({"status": "completed"}) if j % 2 == 0 else None,
                "ca": ts(d, 8 + j % 10),
            },
        )
        doc_count += 1
    src.commit()
    print(f"knowledge_documents: {doc_count} test docs added")

    # 重新拉取文档（含新建的测试文档），供 subtask_contexts / selected_documents 引用
    docs = src.execute(
        text(
            "SELECT id, name, file_extension FROM knowledge_documents "
            "WHERE kind_id=:kid AND is_active=1"
        ),
        {"kid": kb_id},
    ).fetchall()

    # 2. 灌入 subtask_contexts（覆盖检索类指标的所有 JSON 路径）
    span = (target - period_start).days or 1
    sc_count = 0
    for day_offset in range(span + 1):
        d = period_start + timedelta(days=day_offset)
        zero_prob = max(0.05, 0.25 - 0.15 * (day_offset / max(1, span)))

        for j in range(1, queries_per_day + 1):
            uid = user_ids[(day_offset + j) % len(user_ids)]
            mode_r = random.random()

            # 分配注入模式
            if mode_r < 0.55:
                injection_mode = "rag_retrieval"
            elif mode_r < 0.75:
                injection_mode = "direct_injection"
            else:
                injection_mode = "kb_head"

            # chunks_count
            if random.random() < zero_prob:
                chunks_count = 0
            elif mode_r < 0.55:
                chunks_count = random.randint(1, 5)
            else:
                chunks_count = random.randint(6, 10)

            query_text = random.choice(QUERY_POOL)
            latency_ms = random.randint(80, 2500)
            kb_head_count = random.randint(0, 3)
            selected_doc = (
                random.choice(docs).id if docs and random.random() < 0.3 else None
            )

            # 构造完整 type_data（覆盖所有 collector 读取的 JSON 路径）
            rag_result = {
                "injection_mode": injection_mode,
                "query": query_text,
                "chunks_count": chunks_count,
                "retrieval_count": random.randint(1, 5),
                "latency_ms": latency_ms,
                "restricted_mode": random.random() < 0.15,
            }
            type_data = {
                "knowledge_id": kb_id,
                "document_count": len(docs),
                "injection_mode": injection_mode,
                "rag_result": rag_result,
            }

            # adoption_result（覆盖 answer_adoption_rate）
            if chunks_count > 0:
                type_data["adoption_result"] = {
                    "cited_count": random.randint(0, 3) if random.random() < 0.7 else 0
                }

            # kb_head_result（覆盖 rag_head_verify_rate）
            if kb_head_count > 0:
                doc_ids = [random.choice(docs).id] if docs else [1]
                type_data["kb_head_result"] = {
                    "usage_count": kb_head_count,
                    "document_ids": doc_ids,
                }
            type_data["kb_head_count"] = kb_head_count

            # selected_documents（覆盖 selected_documents_usage）
            if selected_doc:
                type_data["rag_result"]["selected_documents"] = [selected_doc]

            name = f"{TEST_PREFIX}sc_kb{kb_id}_d{day_offset}_{j}"
            src.execute(
                text(
                    "INSERT INTO subtask_contexts "
                    "(subtask_id, user_id, context_type, name, status, error_message, "
                    " binary_data, image_base64, extracted_text, text_length, type_data, "
                    " created_at, updated_at) "
                    "VALUES (0, :uid, 'knowledge_base', :name, 'completed', '', "
                    " '', '', :extracted, :tlen, :td, :ca, :ca)"
                ),
                {
                    "uid": uid,
                    "name": name,
                    # extracted_text（rag_retrieval 源数据，供诊断）
                    "extracted": (
                        json.dumps(
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
                        if chunks_count > 0 and injection_mode == "rag_retrieval"
                        else ""
                    ),
                    "tlen": 100 if chunks_count > 0 else 0,
                    "td": json.dumps(type_data),
                    "ca": ts(d, 9 + j % 12),
                },
            )
            sc_count += 1
    src.commit()
    print(f"subtask_contexts: {sc_count} rows across {span + 1} days")

    # 3. 灌入 resource_members（覆盖协作类指标）
    roles = ["Owner", "Maintainer", "Developer", "Reporter"]
    member_count = 0
    all_members = list(user_ids[:4])
    if len(user_ids) > 4:
        all_members.append(user_ids[4])
    for i, uid in enumerate(all_members):
        role = roles[i % len(roles)] if i < 4 else "RestrictedAnalyst"
        # 先检查是否已存在（resource_members 有唯一索引）
        existing = src.execute(
            text(
                "SELECT COUNT(*) FROM resource_members WHERE resource_type='KnowledgeBase' "
                "AND resource_id=:rid AND entity_type='user' AND entity_id=:eid"
            ),
            {"rid": kb_id, "eid": str(uid)},
        ).scalar()
        if existing == 0:
            try:
                src.execute(
                    text(
                        "INSERT INTO resource_members "
                        "(resource_type, resource_id, entity_type, entity_id, entity_display_name, user_id, "
                        " role, status, invited_by_user_id, requested_at, created_at, updated_at) "
                        "VALUES ('KnowledgeBase', :rid, 'user', :eid, :eid, :uid, "
                        " :role, 'approved', :inviter, :ca, :ca, :ca)"
                    ),
                    {
                        "rid": kb_id,
                        "eid": str(uid),
                        "uid": uid,
                        "role": role,
                        "inviter": user_ids[0] if user_ids else 0,
                        "ca": ts(
                            period_start + timedelta(days=random.randint(0, span)), 10
                        ),
                    },
                )
                member_count += 1
            except Exception:
                src.rollback()
    src.commit()
    print(f"resource_members: {member_count} added")

    # 4. 灌入 share_links（覆盖 share_link_usage）
    # 先删除该 KB 的旧测试 share_links，避免 share_token 唯一约束冲突
    # （random.seed 固定导致 token 确定性生成，重复 seed 会产生相同 token）
    src.execute(
        text(
            "DELETE FROM share_links WHERE resource_type='KnowledgeBase' "
            "AND resource_id=:rid AND share_token LIKE :p"
        ),
        {"rid": kb_id, "p": f"{TEST_PREFIX}kb{kb_id}_link_%"},
    )
    src.commit()
    for i in range(2):
        token = f"{TEST_PREFIX}kb{kb_id}_link_{i}_{random.randint(1000,9999)}"
        d = period_start + timedelta(days=random.randint(0, span))
        src.execute(
            text(
                "INSERT INTO share_links "
                "(resource_type, resource_id, share_token, require_approval, default_role, "
                " expires_at, created_by_user_id, is_active, created_at, updated_at) "
                "VALUES ('KnowledgeBase', :rid, :token, :ap, :role, :exp, :uid, 1, :ca, :ca)"
            ),
            {
                "rid": kb_id,
                "token": token,
                "ap": i % 2,
                "role": "Developer",
                "uid": user_ids[i % len(user_ids)],
                "exp": ts(d, 11) + timedelta(days=30),
                "ca": ts(d, 11),
            },
        )
    src.commit()
    print(f"share_links: added")

    # 4.5 灌入 selected_documents 上下文（覆盖 selected_documents_usage）。
    # context_type='selected_documents'，type_data={knowledge_base_id, document_ids}，
    # 与生产 notebook 模式直接注入的上下文结构一致（见
    # backend/app/services/chat/preprocessing/contexts.py）。
    if docs:
        sel_count = 0
        doc_id_list = [doc.id for doc in docs]
        for day_offset in range(span + 1):
            d = period_start + timedelta(days=day_offset)
            for _ in range(random.randint(0, 2)):
                k = random.randint(1, min(3, len(doc_id_list)))
                sample = random.sample(doc_id_list, k=k)
                name = f"{TEST_PREFIX}sc_kb{kb_id}_sel_d{day_offset}_{sel_count}"
                src.execute(
                    text(
                        "INSERT INTO subtask_contexts "
                        "(subtask_id, user_id, context_type, name, status, error_message, "
                        " binary_data, image_base64, extracted_text, text_length, type_data, "
                        " created_at, updated_at) "
                        "VALUES (0, :uid, 'selected_documents', :name, 'completed', '', "
                        " '', '', '', 0, :td, :ca, :ca)"
                    ),
                    {
                        "uid": user_ids[day_offset % len(user_ids)],
                        "name": name,
                        "td": json.dumps(
                            {"knowledge_base_id": kb_id, "document_ids": sample}
                        ),
                        "ca": ts(d, 10 + sel_count % 8),
                    },
                )
                sel_count += 1
        src.commit()
        print(f"selected_documents contexts: {sel_count} rows")

    # 5. 灌入 tasks（覆盖 user_kb_binding）
    for j in range(2):
        name = f"{TEST_PREFIX}task_kb{kb_id}_{j}"
        try:
            src.execute(
                text(
                    "INSERT INTO tasks "
                    "(user_id, kind, name, namespace, json, is_active, project_id, created_at, updated_at) "
                    "VALUES (:uid, 'Task', :name, 'default', :j, 1, 0, :ca, :ca)"
                ),
                {
                    "uid": user_ids[j % len(user_ids)],
                    "name": name,
                    "j": json.dumps(
                        {
                            "spec": {
                                "knowledge_base_ids": [kb_id],
                                "retrievalConfig": {"score_threshold": 0.5, "top_k": 5},
                            }
                        }
                    ),
                    "ca": ts(
                        period_start + timedelta(days=random.randint(0, span)), 14
                    ),
                },
            )
            src.commit()
        except Exception:
            src.rollback()
    print(f"tasks: added")

    src.close()
    print(f"\n✅ seed done for KB {kb_id} ({kb.name})")

    if trigger_collect:
        _trigger_collection(kb_id, target, days)


def _trigger_collection(kb_id: int, target: date, days: int) -> int:
    """Run a KB-scoped collect_all so the latest run includes this KB.

    Mirrors kb_stat_test_data._trigger_collection but scopes to a single KB.
    Snapshot metrics are immediately queryable from this run; dated metrics
    are assembled across successful runs by the query layer.
    """
    from knowledge_engine.stat import collect_all, mark_kb_stat_stale_runs
    from shared.db.readonly_session import (
        get_readonly_session_factory,
        init_readonly_db,
    )
    from shared.db.stat_session import get_stat_session_factory, init_stat_db

    load_dotenv(
        os.path.join(os.path.dirname(__file__), "..", "knowledge_runtime", ".env")
    )
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
        f"  [collect] running collect_all(target={target}, kb_id={kb_id}, "
        f"lookback={days}, triggered_by={TRIGGERED_BY})..."
    )
    run_id = collect_all(
        target_date=target,
        kb_ids=[kb_id],
        lookback_days=days,
        advanced_enabled=True,
        triggered_by=TRIGGERED_BY,
        source_session_factory=get_readonly_session_factory(),
        stat_session_factory=stat_factory,
    )
    print(f"  [collect] done, run_id={run_id}")
    return run_id


def clean_kb(kb_id: int):
    """删除指定 KB 的所有 __test__ 前缀测试数据（源表 + 统计表）。"""
    load_dotenv(
        os.path.join(os.path.dirname(__file__), "..", "knowledge_runtime", ".env")
    )
    engine = create_engine(
        os.environ["DATABASE_URL"], connect_args={"charset": "utf8mb4"}
    )
    src = Session(engine)

    # 统计库
    stat_engine = create_engine(
        os.environ["KNOWLEDGE_STAT_DATABASE_URL"], connect_args={"charset": "utf8mb4"}
    )
    stat = Session(stat_engine)

    total = 0

    # 源表：按 name LIKE '__test__%' 或 share_token LIKE '__test__%'
    for table, col in [
        ("subtask_contexts", "name"),
        ("knowledge_documents", "name"),
        ("share_links", "share_token"),
        ("tasks", "name"),
        ("resource_members", "entity_display_name"),
    ]:
        try:
            if table == "subtask_contexts":
                r = src.execute(
                    text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
                    {"p": f"{TEST_PREFIX}sc_kb{kb_id}_%"},
                )
            elif table == "knowledge_documents":
                r = src.execute(
                    text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
                    {"p": f"{TEST_PREFIX}doc_kb{kb_id}_%"},
                )
            elif table == "share_links":
                r = src.execute(
                    text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
                    {"p": f"{TEST_PREFIX}kb{kb_id}_link_%"},
                )
            elif table == "tasks":
                r = src.execute(
                    text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
                    {"p": f"{TEST_PREFIX}task_kb{kb_id}_%"},
                )
            elif table == "resource_members":
                # 删该 KB 下 entity_display_name 为测试用户的成员
                r = src.execute(
                    text(
                        f"DELETE FROM {table} WHERE resource_type='KnowledgeBase' AND resource_id=:kid "
                        f"AND entity_id IN (SELECT id FROM users WHERE user_name LIKE :p)"
                    ),
                    {"kid": kb_id, "p": f"{TEST_PREFIX}%"},
                )
            if r.rowcount:
                print(f"  [clean] src {table}: deleted {r.rowcount}")
                total += r.rowcount
        except Exception as e:
            print(f"  [clean] src {table}: skipped ({e})")
            src.rollback()
    src.commit()

    # 统计表：删除该 KB 相关的测试 run 数据
    test_runs = [
        r[0]
        for r in stat.execute(
            text("SELECT id FROM kb_stat_runs WHERE triggered_by LIKE :p"),
            {"p": f"{TEST_PREFIX}%"},
        ).fetchall()
    ]
    if test_runs:
        from sqlalchemy import bindparam

        rid_param = bindparam("rids", expanding=True)
        # 动态发现所有有 run_id 的表
        stat_tables = [
            r[0]
            for r in stat.execute(
                text(
                    "SELECT DISTINCT table_name FROM information_schema.columns "
                    "WHERE table_schema=DATABASE() AND column_name='run_id' "
                    "AND table_name LIKE 'kb\\_stat\\_%' ORDER BY table_name"
                )
            ).fetchall()
        ]
        for t in stat_tables:
            r = stat.execute(
                text(f"DELETE FROM `{t}` WHERE run_id IN :rids").bindparams(rid_param),
                {"rids": test_runs},
            )
            if r.rowcount:
                print(f"  [clean] stat {t}: deleted {r.rowcount}")
        stat.execute(
            text("DELETE FROM kb_stat_runs WHERE id IN :rids").bindparams(rid_param),
            {"rids": test_runs},
        )
    stat.commit()
    stat.close()
    src.close()
    print(f"\n✅ clean done: {total} source rows + {len(test_runs)} stat runs removed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Seed/clean test data for a specific KB"
    )
    sub = parser.add_subparsers(dest="cmd")

    p_seed = sub.add_parser("seed", help="Seed test data")
    p_seed.add_argument("--kb-id", type=int, required=True)
    p_seed.add_argument("--days", type=int, default=30)
    p_seed.add_argument("--queries", type=int, default=15)
    p_seed.add_argument(
        "--trigger-collect",
        action="store_true",
        help="Trigger a KB-scoped collect_all after seeding so the detail "
        "page shows data immediately (otherwise re-run kb_stat_backfill.py)",
    )

    p_clean = sub.add_parser("clean", help="Clean test data")
    p_clean.add_argument("--kb-id", type=int, required=True)

    args = parser.parse_args()
    if args.cmd == "seed":
        seed_kb(
            args.kb_id,
            args.days,
            args.queries,
            trigger_collect=args.trigger_collect,
        )
    elif args.cmd == "clean":
        clean_kb(args.kb_id)
    else:
        parser.print_help()
