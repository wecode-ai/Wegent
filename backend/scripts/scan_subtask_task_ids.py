#!/usr/bin/env python3
"""扫描 wegent subtasks 表（含分表）按 team_id + 时间范围导出 task_id 列表。

subtasks 在线上启用了分表（WECODE_TASK_SHARDING），
新格式 task_id 的消息落在 subtasks_XXXX 分表中，老格式在 subtasks 基表。
本脚本自动探测所有分表并合并查询结果。

环境变量/数据库连接与后端统一：与 backend/scripts 下其它脚本一致，
直接复用 app.db.session.SessionLocal，按后端方式读取 backend/.env 与
环境变量（DATABASE_URL 等），不额外实现一套加载逻辑。

两种扫描模式：
  1. 默认 all_shards：逐张探测到的分表按 team_id 过滤。分表少（如本地 16 张）时够用；
     线上 1024 张且每张很大时不推荐。
  2. --users-file 定向模式：先由 aigc-plat-backend 的 list_team_users.py 拿到 team 的
     user 列表，再只扫这些用户 uid 命中的分表 + 老格式基表（按 user_id + team_id 过滤），
     扫描表数量从 1024 降到用户数级别。同一分表被多个用户命中时合并成一次
     chunked IN 查询（不会每用户扫一次该表）；--concurrency 可并行扫不同分表。

用法（在 backend 目录下运行，与 batch_import_eval_permissions.py 一致）:
  cd /path/to/wegent/backend
  uv run python scripts/scan_subtask_task_ids.py --team-id 110467 --from 2026-08-01 --to 2026-08-31
  uv run python scripts/scan_subtask_task_ids.py --team-id 110467 --from 2026-08-01 --to 2026-08-31 --users-file users.json
  uv run python scripts/scan_subtask_task_ids.py --team-id 110467 --from 2026-08-01 --to 2026-08-31 --users-file users.json --concurrency 4

本地覆盖数据库（环境变量优先于 .env）:
  DATABASE_URL=mysql+pymysql://user:pass@host:3306/task_manager \
    uv run python scripts/scan_subtask_task_ids.py --team-id 31 ...

users.json 与 list_team_users.py 输出对齐，也支持 [{"user_name": "alice"}] /
[10001, 10002] / ["alice", "bob"] 等简写；缺 user_id 的名字会自动查 users 表补全。

默认输出精简 JSON（只含 task_ids，与 batch_export.py --task-ids-file 对齐）:
{
  "team_id": 110467,
  "start": "2026-08-01T00:00:00",
  "end": "2026-08-31T00:00:00",
  "generated_at": "2026-09-03T15:30:00",
  "scan_mode": "by_user",
  "user_count": 5,
  "total": 3,
  "task_ids": [1099511778387, 1099511778388, 1099511778389]
}
加 --with-meta 时会多一轮查询并输出 tasks 元数据（title/消息数/时间范围），
供人工核对用；导出任务不需要。
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text as sa_text  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.user import User  # noqa: E402


def _new_session():
    return SessionLocal()


def _discover_subtask_tables(db):
    """从 information_schema 探测所有 subtasks / subtasks_XXXX 表。"""
    rows = db.execute(
        sa_text(
            """
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND (table_name = 'subtasks' OR table_name LIKE 'subtasks\\_%')
            ORDER BY table_name
            """
        )
    ).fetchall()
    # information_schema 列名在 MySQL 上是大写（TABLE_NAME），兼容两种返回
    return [
        row._mapping.get("table_name") or row._mapping.get("TABLE_NAME") for row in rows
    ]


def scan_task_ids(team_id, start, end):
    """扫描所有 subtasks 表，按 team_id + 时间范围查 distinct task_id。

    只返回 task_id 列表（+ 扫过的表），不做元数据聚合查询——
    导出只需要 task_id，元数据会额外再查一轮，默认跳过。
    """
    db = _new_session()
    try:
        tables = _discover_subtask_tables(db)
        if not tables:
            sys.stderr.write("WARNING: no subtasks tables found\n")
            return [], []

        sys.stderr.write(
            "[INFO] Scanning %d table(s): %s\n" % (len(tables), ", ".join(tables))
        )

        all_task_ids = set()
        for table in tables:
            rows = db.execute(
                sa_text(
                    "SELECT DISTINCT task_id FROM `%s` "
                    "WHERE team_id = :team_id AND status != 'DELETE' "
                    "AND created_at >= :start AND created_at < :end" % table
                ),
                {"team_id": team_id, "start": start, "end": end},
            ).fetchall()
            for row in rows:
                all_task_ids.add(int(row._mapping["task_id"]))

        if not all_task_ids:
            return [], tables

        sys.stderr.write("[INFO] Found %d unique task_ids\n" % len(all_task_ids))
        return sorted(all_task_ids), tables
    finally:
        db.close()


# ── 按用户定向扫描（1024 张分表很大时，只扫用户命中的表）───────────────

SLOT_COUNT = 1024  # 与 wecode/task_sharding/task_id.py 的 SLOT_COUNT 一致
UID_MASK = 0xFFFF  # 新格式 task_id 里 uid 只占 16 bit
IN_CHUNK = 500


def _is_power_of_two(n):
    return n > 0 and (n & (n - 1)) == 0


def _split_tables(tables):
    base = "subtasks"
    base_list = [t for t in tables if t == base]
    shard_list = [t for t in tables if t.startswith(base + "_")]
    return base_list, shard_list


def _infer_shard_count(db, shard_tables):
    """从实际存在的 subtasks_XXXX 表数量推断分片数（要求为 2 的幂）。

    优先 --shard-count / WECODE_TASK_SHARD_COUNT；否则按表数量推断；
    推断不了时回退 16（代码默认）。
    """
    count = len(shard_tables)
    if count >= 2 and _is_power_of_two(count):
        return count
    env_count = os.environ.get("WECODE_TASK_SHARD_COUNT", "")
    if env_count.isdigit() and int(env_count) > 0:
        return int(env_count)
    return 16


def _shard_table_for_user(user_id, shard_count):
    """新格式 task 的分表 = subtasks_{(user_id % SLOT_COUNT) % shard_count:04d}。

    与 wecode/task_sharding/shard.py 的路由一致：
      slot = user_id % SLOT_COUNT
      physical = slot % SHARD_COUNT
    """
    slot = user_id % SLOT_COUNT
    physical = slot % shard_count
    return "subtasks_%04d" % physical


def _load_users(path):
    """读 users.json，支持：
    - list_team_users 输出：{"users": [{"user_name": .., "user_id": ..}, ...]}
    - 裸数组 [{"user_name": ..}, ...] 或 [10001, 10002] 或 ["alice", "bob"]
    """
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("users"), list):
        data = data["users"]
    if isinstance(data, dict):
        data = [{"user_name": n} for n in data]
    users = []
    for item in data:
        if isinstance(item, dict):
            users.append(item)
        elif isinstance(item, int) and not isinstance(item, bool):
            users.append({"user_id": item})
        elif isinstance(item, str):
            users.append({"user_name": item})
    return users


def _resolve_names_to_ids(db, users):
    """对缺 user_id 的名字查 wegent users 表补全。返回 (user_id 集合, 未解析名字)。"""
    missing = [u for u in users if not u.get("user_id") and u.get("user_name")]
    name2id = {}
    if missing:
        names = [u["user_name"] for u in missing]
        for i in range(0, len(names), 200):
            chunk = names[i : i + 200]
            rows = (
                db.query(User.id, User.user_name)
                .filter(User.user_name.in_(chunk))
                .all()
            )
            for user_id, user_name in rows:
                name2id[user_name] = int(user_id)
    ids = set()
    unresolved = []
    for u in users:
        uid = u.get("user_id")
        if not uid:
            uid = name2id.get(u.get("user_name"))
        if uid:
            ids.add(int(uid))
        else:
            unresolved.append(u.get("user_name") or u.get("user_id") or "?")
    return ids, unresolved


def _query_task_ids(db, table, team_id, start, end, user_ids=None):
    if user_ids:
        # 同一分表被多个用户命中：一条 IN 查询合并；值太多时分块，
        # 避免超长 SQL 触发 range optimizer 内存上限后退化为全表扫。
        found = []
        uids = sorted(set(user_ids))
        for i in range(0, len(uids), IN_CHUNK):
            chunk = uids[i : i + IN_CHUNK]
            placeholders = ", ".join(":u%d" % j for j in range(len(chunk)))
            params = {"u%d" % j: v for j, v in enumerate(chunk)}
            params.update(team_id=team_id, start=start, end=end)
            rows = db.execute(
                sa_text(
                    "SELECT DISTINCT task_id FROM `%s` "
                    "WHERE user_id IN (%s) AND team_id = :team_id "
                    "AND status != 'DELETE' AND created_at >= :start "
                    "AND created_at < :end" % (table, placeholders)
                ),
                params,
            ).fetchall()
            found.extend(int(row._mapping["task_id"]) for row in rows)
        return found

    rows = db.execute(
        sa_text(
            "SELECT DISTINCT task_id FROM `%s` "
            "WHERE team_id = :team_id AND status != 'DELETE' "
            "AND created_at >= :start AND created_at < :end" % table
        ),
        {"team_id": team_id, "start": start, "end": end},
    ).fetchall()
    return [int(row._mapping["task_id"]) for row in rows]


def _fetch_metadata(db, tables, team_id, start, end, task_ids):
    """对命中 task_id 轻量聚合 title/count/time（不取 prompt/result 大列）。"""
    results = {}
    sorted_ids = sorted(task_ids)
    for table in tables:
        for i in range(0, len(sorted_ids), IN_CHUNK):
            chunk = sorted_ids[i : i + IN_CHUNK]
            placeholders = ", ".join(":t%d" % j for j in range(len(chunk)))
            params = {"t%d" % j: v for j, v in enumerate(chunk)}
            params.update(team_id=team_id, start=start, end=end)
            rows = db.execute(
                sa_text(
                    "SELECT task_id, MAX(title) AS title, COUNT(*) AS msg_count, "
                    "MIN(created_at) AS first_at, MAX(created_at) AS last_at "
                    "FROM `%s` "
                    "WHERE team_id = :team_id AND status != 'DELETE' "
                    "AND created_at >= :start AND created_at < :end "
                    "AND task_id IN (%s) GROUP BY task_id" % (table, placeholders)
                ),
                params,
            ).fetchall()
            for row in rows:
                mapping = row._mapping
                tid = int(mapping["task_id"])
                title = mapping["title"] or ""
                if len(title) > 200:
                    title = title[:200] + "..."
                if tid not in results:
                    results[tid] = {
                        "task_id": tid,
                        "title": title,
                        "message_count": int(mapping["msg_count"]),
                        "first_message_at": (
                            mapping["first_at"].isoformat()
                            if mapping["first_at"]
                            else None
                        ),
                        "last_message_at": (
                            mapping["last_at"].isoformat()
                            if mapping["last_at"]
                            else None
                        ),
                    }
                else:
                    results[tid]["message_count"] += int(mapping["msg_count"])
    return sorted(results.values(), key=lambda t: t["task_id"])


def scan_task_ids_by_users(
    team_id,
    start,
    end,
    user_ids,
    shard_count=None,
    concurrency=1,
):
    """只扫 team 用户命中的分表（+ 老格式基表），按 user_id + team_id 过滤。"""
    db = _new_session()
    try:
        tables = set(_discover_subtask_tables(db))
        _, shard_list = _split_tables(sorted(tables))
        if shard_count is None:
            shard_count = _infer_shard_count(db, shard_list)

        # 每个用户：基表（老 task）+ 自己 uid 命中的分表（新 task）
        relevant = {}
        for uid in sorted(user_ids):
            relevant.setdefault("subtasks", []).append(uid)
            if 0 < uid <= UID_MASK:
                name = _shard_table_for_user(uid, shard_count)
                if name in tables:
                    relevant.setdefault(name, []).append(uid)
                else:
                    sys.stderr.write(
                        "[WARN] shard table %s not found (user %d)\n" % (name, uid)
                    )

        scanned_tables = sorted(relevant)
        sys.stderr.write(
            "[INFO] by-user mode: %d users -> %d distinct table(s) "
            "(same-table users merged into one chunked IN query)\n"
            % (len(user_ids), len(scanned_tables))
        )

        # 第一轮：每张被命中的表只查一次（同表用户合并为 IN）。
        # 注意：分表上 user_id/team_id 均无索引，执行计划通常是
        # created_at 范围扫 + 回表过滤，时间范围越窄越划算。
        def _scan_one(table, uids):
            s = _new_session()
            try:
                return table, _query_task_ids(s, table, team_id, start, end, uids)
            finally:
                s.close()

        per_table_ids = {}
        workers = max(1, concurrency)
        if workers == 1 or len(relevant) == 1:
            for table, uids in relevant.items():
                _, ids = _scan_one(table, uids)
                per_table_ids[table] = ids
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [
                    pool.submit(_scan_one, table, uids)
                    for table, uids in relevant.items()
                ]
                for fut in futures:
                    table, ids = fut.result()
                    per_table_ids[table] = ids

        hit_tables = sorted(t for t, ids in per_table_ids.items() if ids)
        all_task_ids = set()
        for ids in per_table_ids.values():
            all_task_ids.update(ids)

        sys.stderr.write(
            "[INFO] Found %d unique task_ids across %d table(s) with hits\n"
            % (len(all_task_ids), len(hit_tables))
        )
        # 默认只返回 task_id；元数据（title/count/time）是给人看的，
        # 导出用不到，需要时由 main() 在 --with-meta 下单独补一轮。
        return sorted(all_task_ids), shard_count, scanned_tables, hit_tables
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(
        description="扫描 wegent subtasks 表（含分表）按 team_id + 时间范围导出 task_id 列表。"
    )
    parser.add_argument("--team-id", type=int, required=True, help="Team ID")
    parser.add_argument(
        "--from", dest="date_from", required=True, help="起始日期 YYYY-MM-DD（含）"
    )
    parser.add_argument(
        "--to", dest="date_to", required=True, help="结束日期 YYYY-MM-DD（含）"
    )
    parser.add_argument(
        "--users-file",
        default="",
        help="team user 列表 JSON（list_team_users.py 输出）。指定后只扫这些用户命中的分表，"
        "避免 1024 张分表全表扫；缺 user_id 的名字会查 wegent users 表补全",
    )
    parser.add_argument(
        "--shard-count",
        type=int,
        default=0,
        help="分片数（subtasks_XXXX 表数量）。默认自动推断 / WECODE_TASK_SHARD_COUNT / 16",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="并发扫描分表数（默认 1 串行，避免给线上 DB 压力；表多且确认可承受时可调大，如 4）",
    )
    parser.add_argument(
        "--with-meta",
        action="store_true",
        help="额外补一轮查询，输出每个 task 的 title/消息数/时间范围（默认只输出 task_ids，导出用不到元数据）",
    )
    parser.add_argument(
        "-o", "--output", default="task_ids.json", help="输出 JSON 文件路径"
    )
    args = parser.parse_args()

    start = datetime.strptime(args.date_from, "%Y-%m-%d")
    end = datetime.strptime(args.date_to, "%Y-%m-%d") + timedelta(days=1)

    sys.stderr.write(
        "[INFO] team_id=%d range=[%s, %s)\n"
        % (args.team_id, start.isoformat(), end.isoformat())
    )

    scan_mode = "all_shards"
    user_count = 0
    if args.users_file:
        if not os.path.isfile(args.users_file):
            sys.stderr.write("ERROR: --users-file not found: %s\n" % args.users_file)
            sys.exit(1)
        users = _load_users(args.users_file)
        db = _new_session()
        try:
            user_ids, unresolved = _resolve_names_to_ids(db, users)
        finally:
            db.close()
        if unresolved:
            sys.stderr.write(
                "[WARN] %d user(s) 无法解析成 user_id（wegent users 表无此名字）: %s\n"
                % (len(unresolved), ", ".join(unresolved[:20]))
            )
        if not user_ids:
            sys.stderr.write("ERROR: no resolvable user_id from %s\n" % args.users_file)
            sys.exit(1)
        task_ids, shard_count, _, hit_tables = scan_task_ids_by_users(
            args.team_id,
            start,
            end,
            user_ids,
            shard_count=args.shard_count or None,
            concurrency=args.concurrency,
        )
        scan_mode = "by_user"
        user_count = len(user_ids)
        sys.stderr.write("[INFO] shard_count=%d\n" % shard_count)
        meta_tables = hit_tables
    else:
        task_ids, meta_tables = scan_task_ids(args.team_id, start, end)

    tasks = []
    if args.with_meta and task_ids:
        db = _new_session()
        try:
            tasks = _fetch_metadata(db, meta_tables, args.team_id, start, end, task_ids)
        finally:
            db.close()

    output = {
        "team_id": args.team_id,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "generated_at": datetime.now().isoformat(),
        "scan_mode": scan_mode,
        "user_count": user_count,
        "total": len(task_ids),
        "task_ids": task_ids,
    }
    if args.with_meta:
        output["tasks"] = tasks

    output_path = Path(args.output)
    output_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    sys.stderr.write(
        "[INFO] Found %d tasks. Written to %s\n" % (len(task_ids), output_path)
    )
    if task_ids:
        sys.stderr.write(
            "       task_id range: %d ~ %d\n" % (task_ids[0], task_ids[-1])
        )

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
