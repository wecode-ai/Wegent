# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Enforce one active activity comment per runtime identity.

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
            nullable=True,
            comment=(
                "One agent message per (runtime device, task, trigger); "
                "NULL for user messages and soft-deleted rows"
            ),
        ),
    )
    # Backfill only the latest message of each identity group so pre-existing
    # duplicate placeholders never block the unique index.
    op.execute(
        """
        UPDATE project_chat_messages m
        JOIN (
            SELECT runtime_device_id, runtime_task_id, trigger_message_id, MAX(id) AS max_id
            FROM project_chat_messages
            WHERE sender_type = 'agent'
              AND runtime_device_id <> ''
              AND runtime_task_id <> ''
              AND deleted_at = '1970-01-01 00:00:00'
            GROUP BY runtime_device_id, runtime_task_id, trigger_message_id
        ) latest
          ON latest.runtime_device_id = m.runtime_device_id
         AND latest.runtime_task_id = m.runtime_task_id
         AND latest.trigger_message_id = m.trigger_message_id
         AND latest.max_id = m.id
        SET m.runtime_activity_key = SHA2(
            CONCAT(
                m.runtime_device_id, CHAR(0),
                m.runtime_task_id, CHAR(0),
                m.trigger_message_id
            ),
            256
        )
        """
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
