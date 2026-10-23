# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Read-only inventory for human approval of the Wework prompt data migration."""

import hashlib
import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import sqlalchemy as sa


def load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[1]
        / "alembic/versions/20261022_a9c4e7b2d610_correct_wework_file_delivery.py"
    )
    spec = importlib.util.spec_from_file_location("file_delivery_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def fingerprint(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def inventory(connection: sa.Connection) -> dict[str, Any]:
    migration = load_migration()
    table = sa.table(
        "kinds",
        sa.column("id"),
        sa.column("user_id"),
        sa.column("kind"),
        sa.column("namespace"),
        sa.column("name"),
        sa.column("is_active"),
        sa.column("json", sa.JSON()),
    )
    rows = connection.execute(
        sa.select(table.c.id, table.c.is_active, table.c.json)
        .where(
            table.c.user_id == 0,
            table.c.kind == "Ghost",
            table.c.namespace == "default",
            table.c.name == "wegent-wework",
        )
        .order_by(table.c.id)
    ).mappings()
    results = []
    for row in rows:
        payload = row["json"] if isinstance(row["json"], dict) else {}
        spec = payload.get("spec")
        prompt = spec.get("systemPrompt", "") if isinstance(spec, dict) else ""
        prompt = prompt if isinstance(prompt, str) else ""
        match = "custom_or_unrecognized"
        for label, blocks in [
            ("legacy_exact", (migration.OLD_WORKSPACE, migration.OLD_FILE_RULES)),
            (
                "migrated_exact",
                (migration.NEW_WORKSPACE, migration.MIGRATED_FILE_RULES),
            ),
            ("current_seed", (migration.NEW_WORKSPACE, migration.NEW_FILE_RULES)),
        ]:
            if all(prompt.count(block) == 1 for block in blocks):
                match = label
                break
        results.append(
            {
                "id": row["id"],
                "is_active": bool(row["is_active"]),
                "classification": match,
                "payload_sha256": fingerprint(row["json"]),
                "prompt_sha256": fingerprint(prompt),
            }
        )
    return {
        "revision": migration.revision,
        "rows": results,
        "inventory_sha256": fingerprint(results),
    }


def main() -> None:
    from app.db.session import engine

    # No app startup, migration, write statement, or prompt content is emitted.
    with engine.connect() as connection:
        report = inventory(connection)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
