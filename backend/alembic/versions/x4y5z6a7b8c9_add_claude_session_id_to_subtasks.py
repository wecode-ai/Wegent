# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add claude_session_id to subtasks

Revision ID: x4y5z6a7b8c9
Revises: w3x4y5z6a7b8
Create Date: 2025-02-09

This migration adds a claude_session_id column to the subtasks table
to persist Claude SDK session IDs for conversation resume after task restore.

The claude_session_id enables:
- Task restore: New containers can resume conversations using saved session ID
- Conversation continuity: AI remembers previous context after container restart
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "x4y5z6a7b8c9"
down_revision = "w3x4y5z6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add claude_session_id column to subtasks table."""
    op.add_column(
        "subtasks",
        sa.Column(
            "claude_session_id",
            sa.String(255),
            nullable=True,
            comment="Claude SDK session ID for conversation resume",
        ),
    )


def downgrade() -> None:
    """Remove claude_session_id column from subtasks table."""
    op.drop_column("subtasks", "claude_session_id")
