"""Add loop item execution records for project robot queues.

Revision ID: d2e3f4a5b6c7
Revises: a1f4c8d9e2b7
"""

import sqlalchemy as sa

from alembic import op
from shared.models.db.types import big_integer_id_type

revision = "d2e3f4a5b6c7"
down_revision = "a1f4c8d9e2b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "loop_item_executions",
        sa.Column("id", big_integer_id_type(), primary_key=True, autoincrement=True),
        sa.Column("loop_item_id", sa.String(length=64), nullable=False),
        sa.Column("cloud_project_id", sa.String(length=64), nullable=False),
        sa.Column("agent_id", sa.String(length=64), nullable=False),
        sa.Column("execution_environment", sa.String(length=16), nullable=False),
        sa.Column("execution_device_id", sa.String(length=100), nullable=True),
        sa.Column("assigner_user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False, default="queued"),
        sa.Column("priority_weight", sa.Integer(), nullable=False, default=0),
        sa.Column("queued_at", sa.DateTime(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(), nullable=True),
        sa.Column("retry_attempt", sa.Integer(), nullable=False, default=0),
        sa.Column("max_retries", sa.Integer(), nullable=False, default=1),
        sa.Column("error_message", sa.Text(), nullable=False, default=""),
        sa.Column("execution_note", sa.String(length=500), nullable=False, default=""),
        sa.Column("approval_status", sa.String(length=16), nullable=True),
        sa.Column("approved_by_user_id", sa.Integer(), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("rejected_reason", sa.String(length=500), nullable=True),
        sa.Column("runtime_device_id", sa.String(length=255), nullable=True),
        sa.Column("runtime_task_id", sa.String(length=255), nullable=True),
        sa.Column("execution_payload", sa.Text(), nullable=True),
        sa.Column(
            "version", sa.Integer(), nullable=False, default=1, server_default="1"
        ),
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
        sa.Index(
            "ix_exec_device_status_order",
            "execution_device_id",
            "status",
            "priority_weight",
            "queued_at",
        ),
        sa.Index("ix_exec_agent_status", "agent_id", "status"),
        sa.Index("ix_exec_assigner_status", "assigner_user_id", "status"),
        sa.Index("ix_exec_item_status", "loop_item_id", "status"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("loop_item_executions")
