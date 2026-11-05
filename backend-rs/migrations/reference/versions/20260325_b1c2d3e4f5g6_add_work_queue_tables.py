# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add_work_queue_tables

Revision ID: b1c2d3e4f5g6
Revises: a7b8c9d0e1f3
Create Date: 2026-03-25

Add queue_messages and recent_contacts tables for work queue system.
This enables message forwarding and work queue functionality.
"""

import sqlalchemy as sa

from alembic import op

revision = "b1c2d3e4f5g6"
down_revision = "a7b8c9d0e1f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create queue_messages and recent_contacts tables."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = inspector.get_table_names()

    # Create queue_messages table
    if "queue_messages" not in existing_tables:
        op.create_table(
            "queue_messages",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column(
                "queue_id",
                sa.Integer(),
                nullable=False,
                index=True,
                comment="Work queue ID (kinds.id)",
            ),
            sa.Column(
                "sender_user_id",
                sa.Integer(),
                nullable=False,
                index=True,
                comment="Sender user ID",
            ),
            sa.Column(
                "recipient_user_id",
                sa.Integer(),
                nullable=False,
                index=True,
                comment="Recipient user ID (queue owner)",
            ),
            sa.Column(
                "source_task_id",
                sa.Integer(),
                nullable=False,
                index=True,
                comment="Original task/conversation ID",
            ),
            sa.Column(
                "source_subtask_ids",
                sa.JSON(),
                nullable=False,
                comment="List of original message IDs (subtask IDs)",
            ),
            sa.Column(
                "content_snapshot",
                sa.JSON(),
                nullable=False,
                comment="Snapshot of message content including text and attachments",
            ),
            sa.Column(
                "note",
                sa.Text(),
                nullable=False,
                comment="Sender's note/comment",
            ),
            sa.Column(
                "priority",
                sa.Enum("low", "normal", "high", name="queuemessagepriority"),
                nullable=False,
                default="normal",
                index=True,
            ),
            sa.Column(
                "status",
                sa.Enum(
                    "unread",
                    "read",
                    "processing",
                    "processed",
                    "archived",
                    name="queuemessagestatus",
                ),
                nullable=False,
                default="unread",
                index=True,
            ),
            sa.Column(
                "process_result",
                sa.JSON(),
                nullable=False,
                comment="AI processing result",
            ),
            sa.Column(
                "process_task_id",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Task ID created for processing (0 = not processed)",
            ),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
                index=True,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
                onupdate=sa.func.now(),
            ),
            sa.Column(
                "processed_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
                comment="Processing completion time",
            ),
        )

        # Create composite indexes for queue_messages
        op.create_index(
            "ix_queue_messages_queue_status",
            "queue_messages",
            ["queue_id", "status"],
        )
        op.create_index(
            "ix_queue_messages_recipient_status",
            "queue_messages",
            ["recipient_user_id", "status"],
        )

    # Create recent_contacts table
    if "recent_contacts" not in existing_tables:
        op.create_table(
            "recent_contacts",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column(
                "user_id",
                sa.Integer(),
                nullable=False,
                index=True,
                comment="User ID",
            ),
            sa.Column(
                "contact_user_id",
                sa.Integer(),
                nullable=False,
                index=True,
                comment="Contact user ID",
            ),
            sa.Column(
                "last_contact_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
                comment="Last contact time",
            ),
            sa.Column(
                "contact_count",
                sa.Integer(),
                nullable=False,
                default=1,
                comment="Contact count",
            ),
        )

        # Create composite index for recent_contacts
        op.create_index(
            "ix_recent_contacts_user_contact",
            "recent_contacts",
            ["user_id", "contact_user_id"],
        )


def downgrade() -> None:
    """Drop queue_messages and recent_contacts tables."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = inspector.get_table_names()

    if "queue_messages" in existing_tables:
        op.drop_index("ix_queue_messages_recipient_status", table_name="queue_messages")
        op.drop_index("ix_queue_messages_queue_status", table_name="queue_messages")
        op.drop_table("queue_messages")

    if "recent_contacts" in existing_tables:
        op.drop_index("ix_recent_contacts_user_contact", table_name="recent_contacts")
        op.drop_table("recent_contacts")
