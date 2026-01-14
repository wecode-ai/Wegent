"""Add evaluation_judgment field for three-state evaluation

Revision ID: 005
Revises: 004
Create Date: 2026-01-14
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add evaluation_judgment column to evaluation_results table
    op.add_column(
        "evaluation_results",
        sa.Column(
            "evaluation_judgment",
            sa.String(20),
            nullable=True,
            comment="Three-state evaluation judgment: pass/fail/undetermined",
        ),
    )

    # Create index for evaluation_judgment
    op.create_index(
        "idx_evaluation_judgment",
        "evaluation_results",
        ["evaluation_judgment"],
    )


def downgrade() -> None:
    # Drop index
    op.drop_index("idx_evaluation_judgment", table_name="evaluation_results")

    # Drop column
    op.drop_column("evaluation_results", "evaluation_judgment")
