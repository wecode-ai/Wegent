# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""enable automatic updates for cloud marketplace plugin installations

Revision ID: 8a4c1f2d9e70
Revises: f5e4d3c2b1a0
Create Date: 2026-08-12
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "8a4c1f2d9e70"
down_revision: Union[str, Sequence[str], None] = "f5e4d3c2b1a0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _set_cloud_update_policy(policy: str) -> None:
    kinds = sa.table(
        "kinds",
        sa.column("id", sa.Integer()),
        sa.column("kind", sa.String()),
        sa.column("namespace", sa.String()),
        sa.column("is_active", sa.Boolean()),
        sa.column("json", sa.JSON()),
    )
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(kinds.c.id, kinds.c.json).where(
            kinds.c.kind == "InstalledPlugin",
            kinds.c.namespace == "default",
            kinds.c.is_active.is_(True),
        )
    ).fetchall()
    for row in rows:
        payload = row.json if isinstance(row.json, dict) else {}
        spec = payload.get("spec") if isinstance(payload.get("spec"), dict) else {}
        source = spec.get("source") if isinstance(spec.get("source"), dict) else {}
        if source.get("type") != "marketplace" or not isinstance(
            spec.get("pluginId"), int
        ):
            continue
        spec["updatePolicy"] = policy
        payload["spec"] = spec
        connection.execute(
            kinds.update().where(kinds.c.id == row.id).values(json=payload)
        )


def upgrade() -> None:
    _set_cloud_update_policy("auto")


def downgrade() -> None:
    _set_cloud_update_policy("manual")
