"""Add tiered score fields for total score calculation

Revision ID: 003
Revises: 002
Create Date: 2026-01-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add total_score column (0-100 scale)
    op.add_column(
        "evaluation_results",
        sa.Column("total_score", sa.Float(), nullable=True),
    )

    # Add retrieval_score column (0-1 scale, 45% weight)
    op.add_column(
        "evaluation_results",
        sa.Column("retrieval_score", sa.Float(), nullable=True),
    )

    # Add generation_score column (0-1 scale, 55% weight)
    op.add_column(
        "evaluation_results",
        sa.Column("generation_score", sa.Float(), nullable=True),
    )

    # Add is_failed column for hard threshold failure
    op.add_column(
        "evaluation_results",
        sa.Column("is_failed", sa.Boolean(), default=False, nullable=True),
    )

    # Add failure_reason column
    op.add_column(
        "evaluation_results",
        sa.Column("failure_reason", sa.String(500), nullable=True),
    )

    # Create index for total_score
    op.create_index(
        "idx_er_total_score",
        "evaluation_results",
        ["total_score"],
    )

    # Create index for is_failed
    op.create_index(
        "idx_er_is_failed",
        "evaluation_results",
        ["is_failed"],
    )


def downgrade() -> None:
    # Drop indexes
    op.drop_index("idx_er_is_failed", table_name="evaluation_results")
    op.drop_index("idx_er_total_score", table_name="evaluation_results")

    # Drop columns
    op.drop_column("evaluation_results", "failure_reason")
    op.drop_column("evaluation_results", "is_failed")
    op.drop_column("evaluation_results", "generation_score")
    op.drop_column("evaluation_results", "retrieval_score")
    op.drop_column("evaluation_results", "total_score")
