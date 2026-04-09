# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add inbox ai automation fields

Revision ID: a1b2c3d4e5f6
Revises: b1c2d3e4f607
Create Date: 2026-04-09

Add columns to queue_messages for inbox AI auto-processing support,
and inbox_message_id to background_executions for linking executions
to originating inbox messages. Also adds 'failed' enum value to
queue message status.
"""

import logging

import sqlalchemy as sa

from alembic import op

logger = logging.getLogger(__name__)

revision = "a1b2c3d4e5f6"
down_revision = "b1c2d3e4f607"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add inbox AI automation columns and enum values."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    dialect = conn.dialect.name

    # --- Add 'failed' to queue_messages.status enum (MySQL only) ---
    if dialect == "mysql":
        try:
            op.execute(
                sa.text(
                    "ALTER TABLE queue_messages MODIFY COLUMN status "
                    "ENUM('unread','read','processing','processed','archived','failed') "
                    "NOT NULL DEFAULT 'unread'"
                )
            )
        except Exception as exc:
            # Tolerate "already has the value" errors (e.g. re-run)
            logger.warning(
                "Could not add 'failed' to queue_messages.status enum "
                "(may already exist): %s",
                exc,
            )

    # --- queue_messages: new columns ---
    qm_columns = {column["name"] for column in inspector.get_columns("queue_messages")}

    if "process_subscription_id" not in qm_columns:
        op.add_column(
            "queue_messages",
            sa.Column(
                "process_subscription_id",
                sa.Integer(),
                nullable=True,
                comment="Subscription Kind.id used for processing",
            ),
        )

    if "process_error" not in qm_columns:
        op.add_column(
            "queue_messages",
            sa.Column(
                "process_error",
                sa.Text(),
                nullable=True,
                comment="Error message on processing failure",
            ),
        )

    if "processing_started_at" not in qm_columns:
        op.add_column(
            "queue_messages",
            sa.Column(
                "processing_started_at",
                sa.DateTime(),
                nullable=True,
                comment="Processing start time",
            ),
        )

    if "retry_count" not in qm_columns:
        op.add_column(
            "queue_messages",
            sa.Column(
                "retry_count",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Retry attempt count",
            ),
        )

    if "idempotency_key" not in qm_columns:
        op.add_column(
            "queue_messages",
            sa.Column(
                "idempotency_key",
                sa.String(255),
                nullable=True,
                comment="Idempotency key for deduplication",
            ),
        )
        op.create_index(
            "ix_queue_messages_idempotency_key",
            "queue_messages",
            ["idempotency_key"],
            unique=True,
        )

    # --- background_executions: inbox_message_id ---
    be_columns = {
        column["name"] for column in inspector.get_columns("background_executions")
    }

    if "inbox_message_id" not in be_columns:
        op.add_column(
            "background_executions",
            sa.Column(
                "inbox_message_id",
                sa.Integer(),
                nullable=True,
                comment="Originating QueueMessage ID for inbox auto-processing",
            ),
        )
        op.create_index(
            "ix_bg_exec_inbox_message_id",
            "background_executions",
            ["inbox_message_id"],
        )


def downgrade() -> None:
    """Remove inbox AI automation columns and revert enum changes."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    dialect = conn.dialect.name

    # --- background_executions ---
    be_columns = {
        column["name"] for column in inspector.get_columns("background_executions")
    }
    if "inbox_message_id" in be_columns:
        op.drop_index("ix_bg_exec_inbox_message_id", table_name="background_executions")
        op.drop_column("background_executions", "inbox_message_id")

    # --- queue_messages ---
    qm_columns = {column["name"] for column in inspector.get_columns("queue_messages")}

    if "idempotency_key" in qm_columns:
        op.drop_index("ix_queue_messages_idempotency_key", table_name="queue_messages")
        op.drop_column("queue_messages", "idempotency_key")

    for col in [
        "retry_count",
        "processing_started_at",
        "process_error",
        "process_subscription_id",
    ]:
        if col in qm_columns:
            op.drop_column("queue_messages", col)

    # Revert enum (MySQL only)
    if dialect == "mysql":
        try:
            op.execute(
                sa.text(
                    "ALTER TABLE queue_messages MODIFY COLUMN status "
                    "ENUM('unread','read','processing','processed','archived') "
                    "NOT NULL DEFAULT 'unread'"
                )
            )
        except Exception as exc:
            # Tolerate "already reverted" errors (e.g. re-run)
            logger.warning(
                "Could not revert queue_messages.status enum "
                "(may already be reverted): %s",
                exc,
            )
