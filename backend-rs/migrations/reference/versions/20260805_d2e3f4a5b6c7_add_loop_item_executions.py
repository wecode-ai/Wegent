"""Add loop item execution records for project robot queues.

Schema follows production DB audit rules: every column has COMMENT, non-PK
columns are NOT NULL with explicit DEFAULT (TEXT uses expression defaults), no
foreign keys, ordinary indexes use idx_ prefix, and optional API values use
sentinels ('' / 0 / 1970-01-01 00:00:00).

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
        sa.Column(
            "id",
            big_integer_id_type(),
            primary_key=True,
            autoincrement=True,
            comment="Primary key",
        ),
        sa.Column(
            "loop_item_id",
            sa.String(length=64),
            nullable=False,
            server_default="",
            comment="Owning loop item id",
        ),
        sa.Column(
            "cloud_project_id",
            sa.String(length=64),
            nullable=False,
            server_default="",
            comment="Owning cloud project id",
        ),
        sa.Column(
            "agent_id",
            sa.String(length=64),
            nullable=False,
            server_default="",
            comment="Executing robot id",
        ),
        sa.Column(
            "execution_environment",
            sa.String(length=16),
            nullable=False,
            server_default="",
            comment="Execution environment: local/cloud",
        ),
        sa.Column(
            "execution_device_id",
            sa.String(length=100),
            nullable=False,
            server_default="",
            comment="Bound execution device id; empty when unbound",
        ),
        sa.Column(
            "assigner_user_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="User id that assigned the run",
        ),
        sa.Column(
            "status",
            sa.String(length=24),
            nullable=False,
            server_default="queued",
            comment="Run status (pending_approval/queued/claimed/running/completed/failed/cancelled)",
        ),
        sa.Column(
            "priority_weight",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Queue priority weight",
        ),
        sa.Column(
            "queued_at",
            sa.DateTime(),
            nullable=False,
            server_default="1970-01-01 00:00:00",
            comment="Queue entry time; 1970-01-01 00:00:00 means unset",
        ),
        sa.Column(
            "started_at",
            sa.DateTime(),
            nullable=False,
            server_default="1970-01-01 00:00:00",
            comment="Run start time; 1970-01-01 00:00:00 means unset",
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(),
            nullable=False,
            server_default="1970-01-01 00:00:00",
            comment="Terminal time; 1970-01-01 00:00:00 means unset",
        ),
        sa.Column(
            "lease_expires_at",
            sa.DateTime(),
            nullable=False,
            server_default="1970-01-01 00:00:00",
            comment="Claim lease expiry; 1970-01-01 00:00:00 means unset",
        ),
        sa.Column(
            "heartbeat_at",
            sa.DateTime(),
            nullable=False,
            server_default="1970-01-01 00:00:00",
            comment="Last heartbeat; 1970-01-01 00:00:00 means unset",
        ),
        sa.Column(
            "retry_attempt",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Current retry attempt",
        ),
        sa.Column(
            "max_retries",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="Maximum retry attempts",
        ),
        sa.Column(
            "error_message",
            sa.Text(),
            nullable=False,
            server_default=sa.text("('')"),
            comment="Last error message; empty when none",
        ),
        sa.Column(
            "execution_note",
            sa.String(length=500),
            nullable=False,
            server_default="",
            comment="Human-readable run note",
        ),
        sa.Column(
            "approval_status",
            sa.String(length=16),
            nullable=False,
            server_default="",
            comment="Manual approval status (pending/approved/rejected); empty when none",
        ),
        sa.Column(
            "approved_by_user_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Approving user id; 0 means none",
        ),
        sa.Column(
            "approved_at",
            sa.DateTime(),
            nullable=False,
            server_default="1970-01-01 00:00:00",
            comment="Approval time; 1970-01-01 00:00:00 means unset",
        ),
        sa.Column(
            "rejected_reason",
            sa.String(length=500),
            nullable=False,
            server_default="",
            comment="Rejection reason; empty when none",
        ),
        sa.Column(
            "runtime_device_id",
            sa.String(length=255),
            nullable=False,
            server_default="",
            comment="Executor device id; empty when unset",
        ),
        sa.Column(
            "runtime_task_id",
            sa.String(length=255),
            nullable=False,
            server_default="",
            comment="Executor runtime task id; empty when unset",
        ),
        sa.Column(
            "execution_payload",
            sa.Text(),
            nullable=False,
            server_default=sa.text("('')"),
            comment="Prebuilt runtime.tasks.create payload",
        ),
        sa.Column(
            "version",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="Optimistic lock version",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            comment="Last update time",
        ),
        sa.Index(
            "idx_exec_device_status_order",
            "execution_device_id",
            "status",
            "priority_weight",
            "queued_at",
        ),
        sa.Index("idx_exec_agent_status", "agent_id", "status"),
        sa.Index("idx_exec_assigner_status", "assigner_user_id", "status"),
        sa.Index("idx_exec_item_status", "loop_item_id", "status"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("loop_item_executions")
