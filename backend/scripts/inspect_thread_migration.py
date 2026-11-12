#!/usr/bin/env python3
"""Print an authorized migration inventory without modifying data or storage."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-project", type=int, required=True)
    parser.add_argument("--target-group", type=int, required=True)
    parser.add_argument("--actor-user", type=int, required=True)
    parser.add_argument("--status-map-json", default="{}")
    args = parser.parse_args()
    try:
        mapping = json.loads(args.status_map_json)
    except json.JSONDecodeError as error:
        parser.error(f"Invalid --status-map-json: {error.msg}")
    if not isinstance(mapping, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in mapping.items()
    ):
        parser.error(
            "--status-map-json must map status strings to shared Thread states"
        )
    from app.db.session import SessionLocal
    from app.services.thread_migration_inventory import inspect_thread_migration

    with SessionLocal() as db:
        inventory = inspect_thread_migration(
            db,
            source_project_id=args.source_project,
            target_group_id=args.target_group,
            actor_user_id=args.actor_user,
            status_map=mapping,
        )
        print(json.dumps(inventory.to_dict(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
