# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add shared project chat messages.

Revision ID: c0d1e2f3a4b5
Revises: a8b9c0d1e2f3
Create Date: 2026-08-03
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "c0d1e2f3a4b5"
down_revision: Union[str, Sequence[str], None] = "a8b9c0d1e2f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_chat_messages",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("message_id", sa.String(64), nullable=False),
        sa.Column("client_message_id", sa.String(64), nullable=True),
        sa.Column("project_id", sa.String(64), nullable=False),
        sa.Column("task_id", sa.String(64), nullable=True),
        sa.Column("sender_type", sa.String(16), nullable=False),
        sa.Column("sender_id", sa.String(128), nullable=False),
        sa.Column("sender_name", sa.String(255), nullable=False),
        sa.Column("message_type", sa.String(32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=True),
        sa.Column("trigger_message_id", sa.String(64), nullable=True),
        sa.Column("agent_id", sa.String(128), nullable=True),
        sa.Column("runtime_device_id", sa.String(255), nullable=True),
        sa.Column("runtime_task_id", sa.String(255), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["loop_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["loop_items.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("message_id"),
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "uq_project_chat_client_message",
        "project_chat_messages",
        ["sender_type", "sender_id", "client_message_id"],
        unique=True,
    )
    op.create_index(
        "ix_project_chat_project_order",
        "project_chat_messages",
        ["project_id", "id"],
    )
    op.create_index(
        "ix_project_chat_task_order",
        "project_chat_messages",
        ["task_id", "id"],
    )
    op.create_index(
        "uq_project_chat_runtime",
        "project_chat_messages",
        ["runtime_device_id", "runtime_task_id"],
        unique=True,
    )
    op.create_index(
        "uq_project_chat_trigger_agent",
        "project_chat_messages",
        ["trigger_message_id", "agent_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_table("project_chat_messages")
