"""add_workspace_archive_fields_to_tasks

Revision ID: x5y6z7a8b9c0
Revises: w3x4y5z6a7b8
Create Date: 2025-02-02 10:00:00.000000+08:00

This migration adds workspace archive fields to the tasks table for code task recovery.
When an executor is cleaned up, the workspace can be archived to S3 and restored later.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "x5y6z7a8b9c0"
down_revision: Union[str, Sequence[str], None] = "w3x4y5z6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    Add workspace archive fields to tasks table:
    - workspace_archived_at: Timestamp when the workspace was archived
    - workspace_archive_key: S3 key where the archive is stored
    """
    # Add workspace_archived_at column
    op.add_column(
        "tasks",
        sa.Column(
            "workspace_archived_at",
            sa.DateTime(),
            nullable=True,
            comment="Timestamp when workspace was archived to S3",
        ),
    )

    # Add workspace_archive_key column
    op.add_column(
        "tasks",
        sa.Column(
            "workspace_archive_key",
            sa.String(255),
            nullable=True,
            comment="S3 key where workspace archive is stored",
        ),
    )

    # Add index for finding tasks with archives
    op.create_index(
        "idx_workspace_archived_at",
        "tasks",
        ["workspace_archived_at"],
        unique=False,
    )


def downgrade() -> None:
    """
    Remove workspace archive fields from tasks table.
    """
    # Drop index
    op.drop_index("idx_workspace_archived_at", table_name="tasks")

    # Drop columns
    op.drop_column("tasks", "workspace_archive_key")
    op.drop_column("tasks", "workspace_archived_at")
