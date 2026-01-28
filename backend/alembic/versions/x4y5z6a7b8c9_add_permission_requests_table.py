# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add permission_requests table for knowledge base sharing approval workflow

Revision ID: x4y5z6a7b8c9
Revises: w3x4y5z6a7b8
Create Date: 2025-01-28

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "x4y5z6a7b8c9"
down_revision: Union[str, None] = "w3x4y5z6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create permission_requests table
    op.create_table(
        "permission_requests",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind_id", sa.Integer(), nullable=False),
        sa.Column(
            "resource_type",
            sa.String(50),
            nullable=False,
            server_default="knowledge_base",
        ),
        sa.Column("applicant_user_id", sa.Integer(), nullable=False),
        sa.Column(
            "requested_permission_type",
            sa.String(20),
            nullable=False,
            server_default="read",
        ),
        sa.Column("request_reason", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "pending",
                "approved",
                "rejected",
                "cancelled",
                "expired",
                name="permissionrequeststatus",
            ),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("processed_by_user_id", sa.Integer(), nullable=True),
        sa.Column("processed_at", sa.DateTime(), nullable=True),
        sa.Column("response_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        comment="Permission request table for resource access approval workflow",
    )

    # Create indexes
    op.create_index(
        "ix_permission_requests_kind_id", "permission_requests", ["kind_id"]
    )
    op.create_index(
        "ix_permission_requests_applicant_user_id",
        "permission_requests",
        ["applicant_user_id"],
    )
    op.create_index(
        "ix_permission_requests_kb_status", "permission_requests", ["kind_id", "status"]
    )
    op.create_index(
        "ix_permission_requests_applicant",
        "permission_requests",
        ["applicant_user_id", "status"],
    )


def downgrade() -> None:
    # Drop indexes
    op.drop_index("ix_permission_requests_applicant", table_name="permission_requests")
    op.drop_index("ix_permission_requests_kb_status", table_name="permission_requests")
    op.drop_index(
        "ix_permission_requests_applicant_user_id", table_name="permission_requests"
    )
    op.drop_index("ix_permission_requests_kind_id", table_name="permission_requests")

    # Drop table
    op.drop_table("permission_requests")

    # Drop enum type
    op.execute("DROP TYPE IF EXISTS permissionrequeststatus")
