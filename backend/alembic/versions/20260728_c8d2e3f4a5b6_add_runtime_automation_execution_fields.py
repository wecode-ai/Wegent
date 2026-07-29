"""Add runtime automation execution fields.

Revision ID: c8d2e3f4a5b6
Revises: b7c1d2e3f4a5
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "c8d2e3f4a5b6"
down_revision: Union[str, None] = "b7c1d2e3f4a5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "background_executions",
        sa.Column("scheduled_for", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "background_executions",
        sa.Column(
            "source_surface",
            sa.String(length=50),
            server_default="wegent",
            nullable=False,
        ),
    )
    op.add_column(
        "background_executions",
        sa.Column("runtime_device_id", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "background_executions",
        sa.Column("runtime_task_id", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_background_executions_scheduled_for",
        "background_executions",
        ["scheduled_for"],
    )
    op.create_index(
        "ix_background_executions_runtime_device_id",
        "background_executions",
        ["runtime_device_id"],
    )
    op.create_index(
        "ix_background_executions_runtime_task_id",
        "background_executions",
        ["runtime_task_id"],
    )
    op.create_unique_constraint(
        "uq_background_execution_subscription_scheduled_for",
        "background_executions",
        ["subscription_id", "scheduled_for"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_background_execution_subscription_scheduled_for",
        "background_executions",
        type_="unique",
    )
    op.drop_index(
        "ix_background_executions_runtime_task_id",
        table_name="background_executions",
    )
    op.drop_index(
        "ix_background_executions_runtime_device_id",
        table_name="background_executions",
    )
    op.drop_index(
        "ix_background_executions_scheduled_for",
        table_name="background_executions",
    )
    op.drop_column("background_executions", "runtime_task_id")
    op.drop_column("background_executions", "runtime_device_id")
    op.drop_column("background_executions", "source_surface")
    op.drop_column("background_executions", "scheduled_for")
