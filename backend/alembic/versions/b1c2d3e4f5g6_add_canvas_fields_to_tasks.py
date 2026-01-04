"""add canvas fields to tasks table

Revision ID: b1c2d3e4f5g6
Revises: c7d8e9f0a1b2
Create Date: 2025-01-04 12:00:00.000000+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b1c2d3e4f5g6'
down_revision: Union[str, Sequence[str], None] = 'c7d8e9f0a1b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add canvas-related fields to tasks table."""

    # Add canvas fields to tasks table
    op.execute("""
    ALTER TABLE tasks
    ADD COLUMN canvas_enabled BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Whether canvas mode is enabled',
    ADD COLUMN canvas_content TEXT COMMENT 'Canvas content',
    ADD COLUMN canvas_file_type VARCHAR(50) DEFAULT 'text' COMMENT 'Canvas file type',
    ADD COLUMN canvas_title VARCHAR(255) DEFAULT 'Untitled' COMMENT 'Canvas title',
    ADD COLUMN canvas_updated_at DATETIME COMMENT 'Last canvas update time'
    """)


def downgrade() -> None:
    """Remove canvas-related fields from tasks table."""
    op.execute("""
    ALTER TABLE tasks
    DROP COLUMN canvas_enabled,
    DROP COLUMN canvas_content,
    DROP COLUMN canvas_file_type,
    DROP COLUMN canvas_title,
    DROP COLUMN canvas_updated_at
    """)
