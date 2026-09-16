# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""add the built-in Codex public shell

Revision ID: c9d4e7f1a2b3
Revises: b8e2c4f6a901
Create Date: 2026-09-16
"""

import sqlalchemy as sa

from alembic import op

revision = "c9d4e7f1a2b3"
down_revision = "b8e2c4f6a901"
branch_labels = None
depends_on = None

MIGRATION_MARKER = "codex-public-shell-c9d4e7f1a2b3"


def _codex_shell_payload() -> dict[str, object]:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Shell",
        "metadata": {
            "name": "Codex",
            "namespace": "default",
            "labels": {"type": "local_engine"},
            "migrationSource": MIGRATION_MARKER,
        },
        "spec": {
            "shellType": "Codex",
            "supportModel": [],
            "baseImage": "ghcr.io/wecode-ai/wegent-executor:latest",
        },
        "status": {"state": "Available"},
    }


def upgrade() -> None:
    connection = op.get_bind()
    kinds = sa.Table("kinds", sa.MetaData(), autoload_with=connection)
    existing = connection.execute(
        sa.select(kinds.c.id).where(
            kinds.c.user_id == 0,
            kinds.c.kind == "Shell",
            kinds.c.name == "Codex",
            kinds.c.namespace == "default",
            kinds.c.is_active.is_(True),
        )
    ).first()
    if existing is not None:
        return

    connection.execute(
        kinds.insert().values(
            user_id=0,
            kind="Shell",
            name="Codex",
            namespace="default",
            json=_codex_shell_payload(),
            is_active=True,
        )
    )


def downgrade() -> None:
    connection = op.get_bind()
    kinds = sa.Table("kinds", sa.MetaData(), autoload_with=connection)
    rows = connection.execute(
        sa.select(kinds.c.id, kinds.c.json).where(
            kinds.c.user_id == 0,
            kinds.c.kind == "Shell",
            kinds.c.name == "Codex",
            kinds.c.namespace == "default",
        )
    ).fetchall()
    generated_ids = [
        row.id
        for row in rows
        if isinstance(row.json, dict)
        and row.json.get("metadata", {}).get("migrationSource") == MIGRATION_MARKER
    ]
    if generated_ids:
        connection.execute(kinds.delete().where(kinds.c.id.in_(generated_ids)))
