"""Reclassify GitHub mirror plugin as Wework domestic public.

Revision ID: f1a2b3c4d5e6
Revises: e0f1a2b3c4d5
Create Date: 2026-07-30

The adapted GitHub plugin is published under Wework identity
(`source_provider=wework`, `visibility=public`) so it appears in the
domestic-public catalog tab. Upstream coordinates remain Codex/OpenAI.
"""

from __future__ import annotations

import json
from typing import Any, Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "e0f1a2b3c4d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GITHUB_SOURCE_LABEL = "Wegent 官方"
PLUGIN_SNAPSHOT_TABLE = "migration_f1a2b3c4d5e6_plugins"
KIND_SNAPSHOT_TABLE = "migration_f1a2b3c4d5e6_kinds"


def _as_dict(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def upgrade() -> None:
    conn = op.get_bind()
    op.create_table(
        PLUGIN_SNAPSHOT_TABLE,
        sa.Column("plugin_id", sa.BigInteger(), primary_key=True),
        sa.Column("source_provider", sa.String(length=50), nullable=False),
        sa.Column("visibility", sa.String(length=20), nullable=False),
    )
    op.create_table(
        KIND_SNAPSHOT_TABLE,
        sa.Column("kind_id", sa.BigInteger(), primary_key=True),
        sa.Column("payload", sa.JSON(), nullable=False),
    )
    conn.execute(
        sa.text(
            f"""
            INSERT INTO {PLUGIN_SNAPSHOT_TABLE}
                (plugin_id, source_provider, visibility)
            SELECT id, source_provider, visibility
            FROM plugins
            WHERE slug = 'github'
              AND source_type = 'mirror'
              AND source_provider = 'codex'
            """
        )
    )
    conn.execute(
        sa.text(
            f"""
            UPDATE plugins
            SET source_provider = 'wework',
                visibility = 'public'
            WHERE id IN (
                SELECT plugin_id FROM {PLUGIN_SNAPSHOT_TABLE}
            )
            """
        )
    )
    plugin_ids = {
        row["id"]
        for row in conn.execute(
            sa.text(
                f"""
                SELECT plugin_id AS id
                FROM {PLUGIN_SNAPSHOT_TABLE}
                """
            )
        ).mappings()
    }
    if not plugin_ids:
        return

    for row in conn.execute(
        sa.text(
            """
            SELECT id, json
            FROM kinds
            WHERE kind = 'InstalledPlugin'
              AND is_active = 1
            """
        )
    ).mappings():
        payload = _as_dict(row["json"])
        if not payload:
            continue
        spec = payload.get("spec")
        if not isinstance(spec, dict):
            continue
        if spec.get("pluginId") not in plugin_ids:
            continue
        original_payload = row["json"]
        if isinstance(original_payload, (dict, list)):
            original_payload = json.dumps(original_payload, ensure_ascii=False)
        elif isinstance(original_payload, (bytes, bytearray)):
            original_payload = original_payload.decode("utf-8")
        if not isinstance(original_payload, str):
            continue
        conn.execute(
            sa.text(
                f"""
                INSERT INTO {KIND_SNAPSHOT_TABLE} (kind_id, payload)
                VALUES (:kind_id, :payload)
                """
            ),
            {"kind_id": row["id"], "payload": original_payload},
        )
        spec["sourceProvider"] = "wegent"
        spec["sourceLabel"] = GITHUB_SOURCE_LABEL
        spec["visibility"] = "public"
        conn.execute(
            sa.text("UPDATE kinds SET json = :payload WHERE id = :kind_id"),
            {
                "payload": json.dumps(payload, ensure_ascii=False),
                "kind_id": row["id"],
            },
        )


def downgrade() -> None:
    conn = op.get_bind()
    for row in conn.execute(
        sa.text(f"SELECT kind_id, payload FROM {KIND_SNAPSHOT_TABLE}")
    ).mappings():
        conn.execute(
            sa.text("UPDATE kinds SET json = :payload WHERE id = :kind_id"),
            {"payload": row["payload"], "kind_id": row["kind_id"]},
        )
    for row in conn.execute(
        sa.text(
            f"""
            SELECT plugin_id, source_provider, visibility
            FROM {PLUGIN_SNAPSHOT_TABLE}
            """
        )
    ).mappings():
        conn.execute(
            sa.text(
                """
                UPDATE plugins
                SET source_provider = :source_provider,
                    visibility = :visibility
                WHERE id = :plugin_id
                """
            ),
            dict(row),
        )
    op.drop_table(KIND_SNAPSHOT_TABLE)
    op.drop_table(PLUGIN_SNAPSHOT_TABLE)
