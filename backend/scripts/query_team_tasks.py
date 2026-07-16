#!/usr/bin/env python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query task shards by the Team reference stored in the Task JSON."""

from __future__ import annotations

import argparse
import csv
import getpass
from collections import Counter
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Query all task shards for tasks executed with a Team name."
    )
    parser.add_argument("--team-name", required=True)
    parser.add_argument("--host", required=True, help="MySQL server IP or hostname.")
    parser.add_argument("--port", type=int, default=3306)
    parser.add_argument("--user", required=True, help="MySQL username.")
    parser.add_argument(
        "--password",
        help="MySQL password. Omit to enter it without displaying it.",
    )
    parser.add_argument("--database", default="task_manager")
    parser.add_argument(
        "--shard-count",
        type=int,
        default=1024,
        help="Number of task hash shards (default: 1024).",
    )
    parser.add_argument(
        "--start-shard",
        type=int,
        default=0,
        help="First shard to scan (default: 0).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=2000,
        help="Rows scanned by each JSON query (default: 2000).",
    )
    parser.add_argument(
        "--team-owner-user-id",
        type=int,
        help="Optionally restrict teamRef.user_id to one Team owner.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("team_tasks.csv"),
        help="Detailed CSV output path (default: team_tasks.csv).",
    )
    parser.add_argument(
        "--summary-output",
        type=Path,
        default=Path("team_task_summary.csv"),
        help="Summary CSV output path (default: team_task_summary.csv).",
    )
    args = parser.parse_args()
    if args.shard_count <= 0:
        parser.error("--shard-count must be greater than 0")
    if not 0 <= args.start_shard < args.shard_count:
        parser.error("--start-shard must be between 0 and shard-count - 1")
    if args.batch_size <= 0:
        parser.error("--batch-size must be greater than 0")

    owner_condition = ""
    params: dict[str, object] = {"team_name": args.team_name}
    if args.team_owner_user_id is not None:
        owner_condition = """
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.teamRef.user_id'))
                   AS UNSIGNED) = :team_owner_user_id
        """
        params["team_owner_user_id"] = args.team_owner_user_id

    password = args.password
    if password is None:
        password = getpass.getpass("MySQL password: ")
    engine = create_engine(
        URL.create(
            "mysql+pymysql",
            username=args.user,
            password=password,
            host=args.host,
            port=args.port,
            database=args.database,
        ),
        pool_pre_ping=True,
    )
    counts: Counter[tuple[int, int]] = Counter()
    total = 0
    with engine.connect() as db:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", newline="", encoding="utf-8-sig") as output:
            writer = csv.writer(output)
            writer.writerow(
                [
                    "task_id",
                    "task_user_id",
                    "team_name",
                    "team_owner_user_id",
                    "source_table",
                ]
            )

            for shard in range(args.start_shard, args.shard_count):
                table_name = f"tasks_{shard:04d}"
                boundary_query = text(
                    f"""
                    SELECT id
                    FROM `{table_name}`
                    WHERE id > :last_id
                    ORDER BY id
                    LIMIT :batch_size
                    """
                )
                task_query = text(
                    f"""
                    SELECT
                        id AS task_id,
                        user_id AS task_user_id,
                        JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.teamRef.name'))
                            AS team_name,
                        CAST(JSON_UNQUOTE(JSON_EXTRACT(
                            json, '$.spec.teamRef.user_id'
                        )) AS UNSIGNED) AS team_owner_user_id
                    FROM `{table_name}`
                    WHERE id > :last_id
                      AND id <= :end_id
                      AND JSON_UNQUOTE(JSON_EXTRACT(
                        json, '$.spec.teamRef.name'
                      )) = :team_name
                    {owner_condition}
                    """
                )
                last_id = 0
                while True:
                    ids = list(
                        db.execute(
                            boundary_query,
                            {"last_id": last_id, "batch_size": args.batch_size},
                        ).scalars()
                    )
                    if not ids:
                        break

                    end_id = ids[-1]
                    batch_params = {
                        **params,
                        "last_id": last_id,
                        "end_id": end_id,
                    }
                    for row in db.execute(task_query, batch_params):
                        owner_id = int(row.team_owner_user_id)
                        task_user_id = int(row.task_user_id)
                        writer.writerow(
                            [
                                row.task_id,
                                task_user_id,
                                row.team_name,
                                owner_id,
                                table_name,
                            ]
                        )
                        counts[(owner_id, task_user_id)] += 1
                        total += 1

                    last_id = end_id

                if (shard + 1) % 50 == 0 or shard + 1 == args.shard_count:
                    print(f"scanned={shard + 1}/{args.shard_count} matched={total}")

        args.summary_output.parent.mkdir(parents=True, exist_ok=True)
        with args.summary_output.open("w", newline="", encoding="utf-8-sig") as output:
            writer = csv.writer(output)
            writer.writerow(["team_owner_user_id", "task_user_id", "task_count"])
            for (owner_id, task_user_id), count in sorted(counts.items()):
                writer.writerow([owner_id, task_user_id, count])

        print(
            f"total={total} details={args.output.resolve()} "
            f"summary={args.summary_output.resolve()}"
        )
    engine.dispose()


if __name__ == "__main__":
    main()
