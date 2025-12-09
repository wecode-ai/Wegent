# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add impersonation tables

Revision ID: add_impersonation_tables
Revises: add_user_preferences
Create Date: 2025-12-09 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "add_impersonation_tables"
down_revision: Union[str, None] = "add_user_preferences"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create impersonation_requests table
    op.create_table(
        "impersonation_requests",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("admin_user_id", sa.Integer(), nullable=False),
        sa.Column("target_user_id", sa.Integer(), nullable=False),
        sa.Column("token", sa.String(64), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("session_expires_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=True,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["admin_user_id"],
            ["users.id"],
            name="fk_impersonation_requests_admin_user",
        ),
        sa.ForeignKeyConstraint(
            ["target_user_id"],
            ["users.id"],
            name="fk_impersonation_requests_target_user",
        ),
        sa.PrimaryKeyConstraint("id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # Create indexes for impersonation_requests
    op.create_index(
        "ix_impersonation_requests_id", "impersonation_requests", ["id"], unique=False
    )
    op.create_index(
        "ix_impersonation_requests_admin_user_id",
        "impersonation_requests",
        ["admin_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_impersonation_requests_target_user_id",
        "impersonation_requests",
        ["target_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_impersonation_requests_token",
        "impersonation_requests",
        ["token"],
        unique=True,
    )

    # Create impersonation_audit_logs table
    op.create_table(
        "impersonation_audit_logs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("impersonation_request_id", sa.Integer(), nullable=False),
        sa.Column("admin_user_id", sa.Integer(), nullable=False),
        sa.Column("target_user_id", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(50), nullable=False),
        sa.Column("method", sa.String(10), nullable=False),
        sa.Column("path", sa.String(500), nullable=False),
        sa.Column("request_body", sa.Text(), nullable=True),
        sa.Column("ip_address", sa.String(50), nullable=True),
        sa.Column("user_agent", sa.String(500), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(
            ["impersonation_request_id"],
            ["impersonation_requests.id"],
            name="fk_impersonation_audit_logs_request",
        ),
        sa.ForeignKeyConstraint(
            ["admin_user_id"],
            ["users.id"],
            name="fk_impersonation_audit_logs_admin_user",
        ),
        sa.ForeignKeyConstraint(
            ["target_user_id"],
            ["users.id"],
            name="fk_impersonation_audit_logs_target_user",
        ),
        sa.PrimaryKeyConstraint("id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # Create indexes for impersonation_audit_logs
    op.create_index(
        "ix_impersonation_audit_logs_id", "impersonation_audit_logs", ["id"], unique=False
    )
    op.create_index(
        "ix_impersonation_audit_logs_request_id",
        "impersonation_audit_logs",
        ["impersonation_request_id"],
        unique=False,
    )
    op.create_index(
        "ix_impersonation_audit_logs_admin_user_id",
        "impersonation_audit_logs",
        ["admin_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_impersonation_audit_logs_target_user_id",
        "impersonation_audit_logs",
        ["target_user_id"],
        unique=False,
    )


def downgrade() -> None:
    # Drop impersonation_audit_logs table and indexes
    op.drop_index("ix_impersonation_audit_logs_target_user_id", "impersonation_audit_logs")
    op.drop_index("ix_impersonation_audit_logs_admin_user_id", "impersonation_audit_logs")
    op.drop_index("ix_impersonation_audit_logs_request_id", "impersonation_audit_logs")
    op.drop_index("ix_impersonation_audit_logs_id", "impersonation_audit_logs")
    op.drop_table("impersonation_audit_logs")

    # Drop impersonation_requests table and indexes
    op.drop_index("ix_impersonation_requests_token", "impersonation_requests")
    op.drop_index("ix_impersonation_requests_target_user_id", "impersonation_requests")
    op.drop_index("ix_impersonation_requests_admin_user_id", "impersonation_requests")
    op.drop_index("ix_impersonation_requests_id", "impersonation_requests")
    op.drop_table("impersonation_requests")
