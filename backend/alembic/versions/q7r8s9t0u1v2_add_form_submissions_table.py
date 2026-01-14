# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add form_submissions table

Revision ID: q7r8s9t0u1v2
Revises: p6q7r8s9t0u1
Create Date: 2025-01-11 10:00:00.000000

This migration adds the form_submissions table for storing unified form submissions
across different action types (clarification, final_prompt, pipeline_confirmation, etc.).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "q7r8s9t0u1v2"
down_revision: Union[str, None] = "p6q7r8s9t0u1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create form_submissions table."""

    op.create_table(
        "form_submissions",
        sa.Column(
            "id",
            sa.String(36),
            primary_key=True,
            comment="UUID primary key",
        ),
        sa.Column(
            "action_type",
            sa.String(50),
            nullable=False,
            index=True,
            comment="Form action type (clarification, final_prompt, pipeline_confirmation, etc.)",
        ),
        sa.Column(
            "form_data",
            mysql.JSON(),
            nullable=False,
            comment="Form field data submitted by user",
        ),
        sa.Column(
            "context",
            mysql.JSON(),
            nullable=True,
            comment="Submission context (task_id, subtask_id, etc.)",
        ),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "processing", "completed", "error",
                name="formsubmissionstatus"
            ),
            nullable=False,
            server_default="pending",
            index=True,
            comment="Processing status",
        ),
        sa.Column(
            "result",
            mysql.JSON(),
            nullable=True,
            comment="Processing result data",
        ),
        sa.Column(
            "error_message",
            sa.Text(),
            nullable=True,
            comment="Error message if processing failed",
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
            comment="User ID who submitted the form",
        ),
        sa.Column(
            "task_id",
            sa.Integer(),
            sa.ForeignKey("tasks.id"),
            nullable=True,
            index=True,
            comment="Associated task ID (if applicable)",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
            index=True,
            comment="Submission time",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            comment="Last update time",
        ),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # Create additional indexes for common queries
    op.create_index(
        "ix_form_submissions_user_action",
        "form_submissions",
        ["user_id", "action_type"],
    )


def downgrade() -> None:
    """Drop form_submissions table."""

    op.drop_index("ix_form_submissions_user_action", table_name="form_submissions")
    op.drop_table("form_submissions")
