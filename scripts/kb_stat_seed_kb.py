#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""为指定知识库灌入完整的检索测试数据，覆盖所有统计表的源数据需求。

Usage:
    cd knowledge_engine
    set -a && . ../knowledge_runtime/.env && set +a
    .venv/bin/python ../scripts/kb_stat_seed_kb.py --kb-id 148 --days 30
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


def seed_kb(kb_id: int, days: int = 30, queries_per_day: int = 15, target_date=None):
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
                    # extracted_text（覆盖 retrieval_score_distribution）
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

    # 5. 更新文档的 chunks/summary（确保 content_quality 指标有数据）
    for doc in docs:
        chunk_count = random.randint(1, 8)
        splitter = random.choice(["recursive", "semantic", "fixed"])
        src.execute(
            text("UPDATE knowledge_documents SET chunks=:c WHERE id=:id"),
            {
                "id": doc.id,
                "c": json.dumps(
                    {
                        "splitter_type": splitter,
                        "total_count": chunk_count,
                        "items": [
                            {
                                "token_count": random.randint(50, 500),
                                "score": round(random.uniform(0.2, 0.95), 2),
                            }
                            for _ in range(min(chunk_count, 5))
                        ],
                    }
                ),
            },
        )
        # 部分 doc 有 summary，部分没有
        if random.random() < 0.6:
            src.execute(
                text("UPDATE knowledge_documents SET summary=:s WHERE id=:id"),
                {
                    "id": doc.id,
                    "s": json.dumps(
                        {"status": "completed", "short_summary": "test summary"}
                    ),
                },
            )
    src.commit()
    print(f"documents: updated chunks/summary for {len(docs)} docs")

    # 6. 灌入 tasks（覆盖 user_kb_binding）
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
        ("share_links", "share_token"),
        ("tasks", "name"),
        ("resource_members", "entity_display_name"),
        ("users", "user_name"),
    ]:
        try:
            r = src.execute(
                text(
                    f"DELETE FROM {table} WHERE {col} LIKE :p AND ({col} LIKE :kbp OR {col} NOT LIKE :kbp)"
                ),
                {"p": f"{TEST_PREFIX}%", "kbp": f"{TEST_PREFIX}%kb{kb_id}%"},
            )
            # 更精确：只删该 KB 相关的测试数据
            if table == "subtask_contexts":
                r = src.execute(
                    text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
                    {"p": f"{TEST_PREFIX}sc_kb{kb_id}_%"},
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
            elif table == "users":
                # 只删测试用户（如果没被其他表引用）
                r = src.execute(
                    text(f"DELETE FROM {table} WHERE {col} LIKE :p"),
                    {"p": f"{TEST_PREFIX}%"},
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

    p_clean = sub.add_parser("clean", help="Clean test data")
    p_clean.add_argument("--kb-id", type=int, required=True)

    args = parser.parse_args()
    if args.cmd == "seed":
        seed_kb(args.kb_id, args.days, args.queries)
    elif args.cmd == "clean":
        clean_kb(args.kb_id)
    else:
        parser.print_help()
