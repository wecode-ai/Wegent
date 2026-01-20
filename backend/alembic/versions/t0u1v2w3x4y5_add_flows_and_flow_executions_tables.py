"""add flows and flow_executions tables

Revision ID: t0u1v2w3x4y5
Revises: s9t0u1v2w3x4
Create Date: 2026-01-19 18:53:00.000000+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "t0u1v2w3x4y5"
down_revision: Union[str, Sequence[str], None] = "s9t0u1v2w3x4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema - Create flows and flow_executions tables."""

    # Create flow_executions table
    op.create_table(
        "flow_executions",
        sa.Column(
            "id",
            sa.Integer(),
            nullable=False,
            autoincrement=True,
            comment="Primary key",
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="User ID who triggered this execution",
        ),
        sa.Column(
            "flow_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Associated flow ID",
        ),
        sa.Column(
            "task_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Associated task ID if execution creates a task",
        ),
        sa.Column(
            "trigger_type",
            sa.String(length=50),
            nullable=False,
            server_default="manual",
            comment="Trigger type: cron, webhook, manual, etc.",
        ),
        sa.Column(
            "trigger_reason",
            sa.String(length=500),
            nullable=False,
            server_default="",
            comment="Reason or description for this execution",
        ),
        sa.Column(
            "prompt",
            sa.Text(),
            nullable=False,
            comment="Prompt or instruction for the execution",
        ),
        sa.Column(
            "status",
            sa.String(length=50),
            nullable=False,
            server_default="PENDING",
            comment="Execution status: PENDING, RUNNING, SUCCESS, FAILED, etc.",
        ),
        sa.Column(
            "result_summary",
            sa.Text(),
            nullable=False,
            comment="Summary of execution result",
        ),
        sa.Column(
            "error_message",
            sa.Text(),
            nullable=False,
            comment="Error message if execution failed",
        ),
        sa.Column(
            "retry_attempt",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Number of retry attempts",
        ),
        sa.Column(
            "started_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
            comment="Execution start timestamp",
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
            comment="Execution completion timestamp",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
            comment="Creation timestamp",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            comment="Last update timestamp",
        ),
        sa.Column(
            "version",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Version number for optimistic locking",
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Create indexes for flow_executions table
    op.create_index("idx_flow_exec_user_id", "flow_executions", ["user_id"])
    op.create_index("idx_flow_exec_flow_id", "flow_executions", ["flow_id"])
    op.create_index("idx_flow_exec_task_id", "flow_executions", ["task_id"])
    op.create_index("idx_flow_exec_status", "flow_executions", ["status"])
    op.create_index("idx_flow_exec_created_at", "flow_executions", ["created_at"])
    op.create_index(
        "idx_flow_exec_user_created", "flow_executions", ["user_id", "created_at"]
    )
    op.create_index(
        "idx_flow_exec_flow_created", "flow_executions", ["flow_id", "created_at"]
    )
    op.create_index(
        "idx_flow_exec_user_status", "flow_executions", ["user_id", "status"]
    )


def downgrade() -> None:
    """Downgrade schema - Drop flows and flow_executions tables."""
    op.drop_table("flow_executions")
