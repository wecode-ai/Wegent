# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add_im_private_sessions

Revision ID: e7f8a9b0c1d2
Revises: d5e6f7a8b9c0
Create Date: 2026-06-20

Create persistent private IM session state for task continuation.
"""

import sqlalchemy as sa

from alembic import op

revision = "e7f8a9b0c1d2"
down_revision = "d5e6f7a8b9c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create private IM session state table."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    if "im_private_sessions" in inspector.get_table_names():
        return

    bigint_id = sa.BigInteger().with_variant(sa.Integer(), "sqlite")

    op.create_table(
        "im_private_sessions",
        sa.Column("id", bigint_id, primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("channel_type", sa.String(length=32), nullable=False),
        sa.Column("channel_id", bigint_id, nullable=False),
        sa.Column("conversation_id", sa.String(length=255), nullable=False),
        sa.Column("sender_id", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("active_task_id", bigint_id, nullable=True),
        sa.Column("pending_payload", sa.JSON(), nullable=False),
        sa.Column("state_expires_at", sa.DateTime(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "channel_type",
            "channel_id",
            "conversation_id",
            "user_id",
            name="uniq_im_private_session_identity",
        ),
        sqlite_autoincrement=True,
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index(
        "ix_im_private_sessions_user_id",
        "im_private_sessions",
        ["user_id"],
    )
    op.create_index(
        "ix_im_private_sessions_channel_id",
        "im_private_sessions",
        ["channel_id"],
    )
    op.create_index(
        "ix_im_private_sessions_active_task_id",
        "im_private_sessions",
        ["active_task_id"],
    )


def downgrade() -> None:
    """Drop private IM session state table."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    if "im_private_sessions" not in inspector.get_table_names():
        return

    op.drop_index(
        "ix_im_private_sessions_active_task_id",
        table_name="im_private_sessions",
    )
    op.drop_index(
        "ix_im_private_sessions_channel_id",
        table_name="im_private_sessions",
    )
    op.drop_index(
        "ix_im_private_sessions_user_id",
        table_name="im_private_sessions",
    )
    op.drop_table("im_private_sessions")
