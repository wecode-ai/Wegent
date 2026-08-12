# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Enforce one activity comment per runtime identity.

Robot runs (empty trigger) and chat continuations (own trigger) previously
relied on a check-then-insert convention, so concurrent openers could create
duplicate "AI 执行" comments. The unique index on runtime_activity_key turns
"one activity message per (runtime device, task, trigger)" into a database
invariant.

Revision ID: f5e4d3c2b1a0
Revises: 735edcb17bec
Create Date: 2026-08-12
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f5e4d3c2b1a0"
down_revision: Union[str, Sequence[str], None] = "735edcb17bec"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "project_chat_messages",
        sa.Column(
            "runtime_activity_key",
            sa.String(64),
            nullable=False,
            comment=(
                "Stable runtime identity for agent activity; message identity otherwise"
            ),
        ),
    )
    op.create_index(
        "uniq_project_chat_runtime_activity",
        "project_chat_messages",
        ["runtime_activity_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uniq_project_chat_runtime_activity",
        table_name="project_chat_messages",
    )
    op.drop_column("project_chat_messages", "runtime_activity_key")
