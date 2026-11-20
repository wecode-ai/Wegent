"""Add task timing spans

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c2d3e4f5a6b7"
down_revision: str | Sequence[str] | None = "b1c2d3e4f5a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "task_timing_spans",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("task_id", sa.BigInteger(), nullable=False),
        sa.Column("subtask_id", sa.BigInteger(), nullable=True),
        sa.Column("turn_id", sa.String(length=100), nullable=False, server_default=""),
        sa.Column(
            "parent_span_id", sa.String(length=100), nullable=False, server_default=""
        ),
        sa.Column("span_id", sa.String(length=100), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("actor_id", sa.String(length=200), nullable=False, server_default=""),
        sa.Column(
            "actor_type", sa.String(length=32), nullable=False, server_default=""
        ),
        sa.Column(
            "actor_label", sa.String(length=300), nullable=False, server_default=""
        ),
        sa.Column(
            "status", sa.String(length=24), nullable=False, server_default="running"
        ),
        sa.Column("start_at_ms", sa.BigInteger(), nullable=True),
        sa.Column("end_at_ms", sa.BigInteger(), nullable=True),
        sa.Column("duration_ms", sa.BigInteger(), nullable=True),
        sa.Column("clock", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("source", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("span_id", name="uniq_task_timing_span_id"),
    )
    op.create_index(
        "idx_task_timing_spans_task",
        "task_timing_spans",
        ["task_id", "start_at_ms", "id"],
    )
    op.create_index(
        "idx_task_timing_spans_actor",
        "task_timing_spans",
        ["task_id", "actor_id", "start_at_ms"],
    )
    op.create_index(
        "idx_task_timing_spans_kind",
        "task_timing_spans",
        ["task_id", "kind", "start_at_ms"],
    )


def downgrade() -> None:
    op.drop_index("idx_task_timing_spans_kind", table_name="task_timing_spans")
    op.drop_index("idx_task_timing_spans_actor", table_name="task_timing_spans")
    op.drop_index("idx_task_timing_spans_task", table_name="task_timing_spans")
    op.drop_table("task_timing_spans")
