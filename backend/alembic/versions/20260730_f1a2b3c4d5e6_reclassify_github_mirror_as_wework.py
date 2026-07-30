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
    conn.execute(
        sa.text(
            """
            UPDATE plugins
            SET source_provider = 'wework',
                visibility = 'public'
            WHERE slug = 'github'
              AND source_type = 'mirror'
              AND source_provider = 'codex'
            """
        )
    )
    plugin_ids = {
        row["id"]
        for row in conn.execute(
            sa.text(
                """
                SELECT id
                FROM plugins
                WHERE slug = 'github'
                  AND source_type = 'mirror'
                  AND source_provider = 'wework'
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
    conn.execute(
        sa.text(
            """
            UPDATE plugins
            SET source_provider = 'codex'
            WHERE slug = 'github'
              AND source_type = 'mirror'
              AND source_provider = 'wework'
            """
        )
    )
