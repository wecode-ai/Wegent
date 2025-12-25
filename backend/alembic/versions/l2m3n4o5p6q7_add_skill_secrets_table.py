# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add skill_secrets table for MCP skill configurations

Revision ID: l2m3n4o5p6q7
Revises: k1l2m3n4o5p6
Create Date: 2025-12-20 10:00:00.000000+08:00

This migration creates:
1. skill_secrets table for storing encrypted sensitive configurations per Ghost
   - Used for MCP type skills that require environment variables (API keys, tokens, etc.)
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "l2m3n4o5p6q7"
down_revision: Union[str, None] = "k1l2m3n4o5p6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create skill_secrets table."""

    # Create skill_secrets table
    op.create_table(
        "skill_secrets",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        sa.Column("ghost_id", sa.Integer(), nullable=False),  # References kinds.id (Ghost)
        sa.Column("skill_id", sa.Integer(), nullable=False),  # References kinds.id (Skill)
        sa.Column("encrypted_env", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ghost_id", "skill_id", name="uq_ghost_skill_secret"),
    )

    # Create indexes for skill_secrets
    op.create_index("ix_skill_secrets_id", "skill_secrets", ["id"])
    op.create_index("idx_skill_secret_ghost", "skill_secrets", ["ghost_id"])
    op.create_index("idx_skill_secret_skill", "skill_secrets", ["skill_id"])


def downgrade() -> None:
    """Drop skill_secrets table."""

    # Drop skill_secrets table
    op.drop_index("idx_skill_secret_skill", table_name="skill_secrets")
    op.drop_index("idx_skill_secret_ghost", table_name="skill_secrets")
    op.drop_index("ix_skill_secrets_id", table_name="skill_secrets")
    op.drop_table("skill_secrets")
