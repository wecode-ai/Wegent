# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add shared project chat messages.

Schema follows production DB audit rules: every column has COMMENT, non-PK
columns are NOT NULL with explicit DEFAULT (TEXT/JSON use expression defaults),
no foreign keys, unique indexes use uniq_ prefix and ordinary indexes use
idx_ prefix, and optional API values use sentinels ('' / 1970-01-01 00:00:00).

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
        sa.Column(
            "id",
            sa.BigInteger(),
            autoincrement=True,
            nullable=False,
            comment="Primary key",
        ),
        sa.Column(
            "message_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Stable unique message id",
        ),
        sa.Column(
            "client_message_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Client message id for idempotency; empty when unset",
        ),
        sa.Column(
            "project_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Owning loop item id",
        ),
        sa.Column(
            "task_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Bound task loop item id; empty when unset",
        ),
        sa.Column(
            "sender_type",
            sa.String(16),
            nullable=False,
            server_default="",
            comment="Sender kind: user/agent",
        ),
        sa.Column(
            "sender_id",
            sa.String(128),
            nullable=False,
            server_default="",
            comment="Sender user or agent id",
        ),
        sa.Column(
            "sender_name",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="Sender display name",
        ),
        sa.Column(
            "message_type",
            sa.String(32),
            nullable=False,
            server_default="text",
            comment="Message type (text/agent_chunk)",
        ),
        sa.Column(
            "content",
            sa.Text(),
            nullable=False,
            server_default=sa.text("('')"),
            comment="Message body",
        ),
        sa.Column(
            "metadata",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("(JSON_OBJECT())"),
            comment="Extension metadata (mentions, model, run state)",
        ),
        sa.Column(
            "trigger_message_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Source message that triggered an agent response; empty when unset",
        ),
        sa.Column(
            "agent_id",
            sa.String(128),
            nullable=False,
            server_default="",
            comment="Responding robot id; empty for user messages",
        ),
        sa.Column(
            "runtime_device_id",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="Executor device id; empty when unset",
        ),
        sa.Column(
            "runtime_task_id",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="Executor runtime task id; empty when unset",
        ),
        sa.Column(
            "reply_to_message_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Parent message id in a reply thread; empty when unset",
        ),
        sa.Column(
            "thread_root_message_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Thread root message id; empty when unset",
        ),
        sa.Column(
            "status",
            sa.String(16),
            nullable=False,
            server_default="completed",
            comment="Message status (streaming/running/completed/failed)",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            comment="Last update time",
        ),
        sa.Column(
            "deleted_at",
            sa.DateTime(),
            nullable=False,
            server_default="1970-01-01 00:00:00",
            comment="Soft delete time; 1970-01-01 00:00:00 means not deleted",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("message_id", name="uniq_project_chat_message_id"),
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_project_chat_client_message",
        "project_chat_messages",
        ["sender_type", "sender_id", "client_message_id"],
        unique=False,
    )
    op.create_index(
        "idx_project_chat_project_order",
        "project_chat_messages",
        ["project_id", "id"],
    )
    op.create_index(
        "idx_project_chat_task_order",
        "project_chat_messages",
        ["task_id", "id"],
    )
    op.create_index(
        "idx_project_chat_runtime",
        "project_chat_messages",
        ["runtime_device_id", "runtime_task_id", "id"],
        unique=False,
    )
    op.create_index(
        "idx_project_chat_trigger_agent",
        "project_chat_messages",
        ["trigger_message_id", "agent_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_table("project_chat_messages")
