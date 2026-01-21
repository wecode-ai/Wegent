# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Add flows and flow_executions tables for AI Flow module.

Revision ID: q7r8s9t0u1v2
Revises: p6q7r8s9t0u1
Create Date: 2025-01-10 10:00:00.000000

This migration creates the flows and flow_executions tables for the AI Flow
(智能流) module, which enables automated task execution with various trigger types.
"""

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

# revision identifiers, used by Alembic.
revision = "q7r8s9t0u1v2"
down_revision = "p6q7r8s9t0u1"
branch_labels = None
depends_on = None


def upgrade():
    """Create flows and flow_executions tables."""
    # 1. Create flows table
    op.create_table(
        "flows",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(50), nullable=False, server_default="Flow"),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "namespace", sa.String(255), nullable=False, server_default="default"
        ),
        sa.Column("json", mysql.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("trigger_type", sa.String(50), nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=True),
        sa.Column("workspace_id", sa.Integer(), nullable=True),
        sa.Column("webhook_token", sa.String(255), nullable=True),
        sa.Column("last_execution_time", sa.DateTime(), nullable=True),
        sa.Column("last_execution_status", sa.String(50), nullable=True),
        sa.Column("next_execution_time", sa.DateTime(), nullable=True),
        sa.Column("execution_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("success_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failure_count", sa.Integer(), nullable=False, server_default="0"),
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
            onupdate=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Create indexes for flows table
    op.create_index("ix_flows_user_id", "flows", ["user_id"])
    op.create_index("ix_flows_enabled", "flows", ["enabled"])
    op.create_index("ix_flows_trigger_type", "flows", ["trigger_type"])
    op.create_index("ix_flows_team_id", "flows", ["team_id"])
    op.create_index("ix_flows_next_execution_time", "flows", ["next_execution_time"])
    op.create_index(
        "ix_flows_user_kind_name_ns",
        "flows",
        ["user_id", "kind", "name", "namespace"],
        unique=True,
    )
    op.create_index(
        "ix_flows_enabled_next_exec", "flows", ["enabled", "next_execution_time"]
    )
    op.create_index("ix_flows_user_active", "flows", ["user_id", "is_active"])
    op.create_index("ix_flows_webhook_token", "flows", ["webhook_token"], unique=True)

    # 2. Create flow_executions table
    op.create_table(
        "flow_executions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("flow_id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=True),
        sa.Column("trigger_type", sa.String(50), nullable=False),
        sa.Column("trigger_reason", sa.String(500), nullable=True),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("status", sa.String(50), nullable=False, server_default="PENDING"),
        sa.Column("result_summary", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("retry_attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
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
            onupdate=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["flow_id"], ["flows.id"], ondelete="CASCADE"),
    )

    # Create indexes for flow_executions table
    op.create_index("ix_flow_exec_user_id", "flow_executions", ["user_id"])
    op.create_index("ix_flow_exec_flow_id", "flow_executions", ["flow_id"])
    op.create_index("ix_flow_exec_task_id", "flow_executions", ["task_id"])
    op.create_index("ix_flow_exec_status", "flow_executions", ["status"])
    op.create_index("ix_flow_exec_created_at", "flow_executions", ["created_at"])
    op.create_index(
        "ix_flow_exec_user_created", "flow_executions", ["user_id", "created_at"]
    )
    op.create_index(
        "ix_flow_exec_flow_created", "flow_executions", ["flow_id", "created_at"]
    )
    op.create_index(
        "ix_flow_exec_user_status", "flow_executions", ["user_id", "status"]
    )


def downgrade():
    """Drop flows and flow_executions tables."""
    # Drop flow_executions table and its indexes
    op.drop_index("ix_flow_exec_user_status", table_name="flow_executions")
    op.drop_index("ix_flow_exec_flow_created", table_name="flow_executions")
    op.drop_index("ix_flow_exec_user_created", table_name="flow_executions")
    op.drop_index("ix_flow_exec_created_at", table_name="flow_executions")
    op.drop_index("ix_flow_exec_status", table_name="flow_executions")
    op.drop_index("ix_flow_exec_task_id", table_name="flow_executions")
    op.drop_index("ix_flow_exec_flow_id", table_name="flow_executions")
    op.drop_index("ix_flow_exec_user_id", table_name="flow_executions")
    op.drop_table("flow_executions")

    # Drop flows table and its indexes
    op.drop_index("ix_flows_webhook_token", table_name="flows")
    op.drop_index("ix_flows_user_active", table_name="flows")
    op.drop_index("ix_flows_enabled_next_exec", table_name="flows")
    op.drop_index("ix_flows_user_kind_name_ns", table_name="flows")
    op.drop_index("ix_flows_next_execution_time", table_name="flows")
    op.drop_index("ix_flows_team_id", table_name="flows")
    op.drop_index("ix_flows_trigger_type", table_name="flows")
    op.drop_index("ix_flows_enabled", table_name="flows")
    op.drop_index("ix_flows_user_id", table_name="flows")
    op.drop_table("flows")
