"""drop claude_session_id column from subtasks

Revision ID: 2607db2c2be9
Revises: 26e05c6de5a5
Create Date: 2026-02-09 11:36:09.156509+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2607db2c2be9'
down_revision: Union[str, Sequence[str], None] = '26e05c6de5a5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Drop claude_session_id column from subtasks table
    op.drop_column('subtasks', 'claude_session_id')


def downgrade() -> None:
    """Downgrade schema."""
    # Re-add claude_session_id column to subtasks table
    op.add_column(
        'subtasks',
        sa.Column(
            'claude_session_id',
            sa.String(255),
            nullable=True,
            comment='Claude SDK session ID for conversation resume'
        )
    )
