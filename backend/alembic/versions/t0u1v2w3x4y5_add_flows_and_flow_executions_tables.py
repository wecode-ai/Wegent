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

    # Create flows table
    op.create_table(
        "flows",
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
            comment="User ID who owns this flow",
        ),
        sa.Column(
            "kind",
            sa.String(length=50),
            nullable=False,
            server_default="Flow",
            comment="Resource kind, default is Flow",
        ),
        sa.Column(
            "name",
            sa.String(length=255),
            nullable=False,
            server_default="",
            comment="Flow name",
        ),
        sa.Column(
            "namespace",
            sa.String(length=255),
            nullable=False,
            server_default="default",
            comment="Namespace for resource isolation",
        ),
        sa.Column(
            "json",
            sa.JSON(),
            nullable=False,
            comment="Flow configuration in JSON format",
        ),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default="1",
            comment="Whether the flow is active",
        ),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default="1",
            comment="Whether the flow is enabled for execution",
        ),
        sa.Column(
            "trigger_type",
            sa.String(length=50),
            nullable=False,
            server_default="manual",
            comment="Trigger type: cron, webhook, manual, etc.",
        ),
        sa.Column(
            "team_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Associated team ID",
        ),
        sa.Column(
            "workspace_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Associated workspace ID",
        ),
        sa.Column(
            "webhook_token",
            sa.String(length=255),
            nullable=False,
            server_default="",
            comment="Unique token for webhook trigger",
        ),
        sa.Column(
            "last_execution_time",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
            comment="Last execution timestamp",
        ),
        sa.Column(
            "last_execution_status",
            sa.String(length=50),
            nullable=False,
            server_default="",
            comment="Last execution status",
        ),
        sa.Column(
            "next_execution_time",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
            comment="Next scheduled execution time",
        ),
        sa.Column(
            "execution_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Total execution count",
        ),
        sa.Column(
            "success_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Successful execution count",
        ),
        sa.Column(
            "failure_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Failed execution count",
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
            "webhook_secret",
            sa.String(length=255),
            nullable=False,
            server_default="",
            comment="Webhook secret for validation",
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Create indexes for flows table
    op.create_index("idx_flows_user_id", "flows", ["user_id"])
    op.create_index("idx_flows_enabled", "flows", ["enabled"])
    op.create_index("idx_flows_trigger_type", "flows", ["trigger_type"])
    op.create_index("idx_flows_team_id", "flows", ["team_id"])
    op.create_index("idx_flows_next_execution_time", "flows", ["next_execution_time"])
    op.create_index(
        "uniq_flows_user_kind_name_ns",
        "flows",
        ["user_id", "kind", "name", "namespace"],
        unique=True,
    )
    op.create_index(
        "idx_flows_enabled_next_exec", "flows", ["enabled", "next_execution_time"]
    )
    op.create_index("idx_flows_user_active", "flows", ["user_id", "is_active"])
    op.create_index("uniq_flows_webhook_token", "flows", ["webhook_token"], unique=True)

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
    op.drop_table("flows")
