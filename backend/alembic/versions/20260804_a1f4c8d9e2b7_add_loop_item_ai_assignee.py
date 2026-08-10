"""Add an AI assignee to project work items.

Revision ID: a1f4c8d9e2b7
Revises: c0d1e2f3a4b5
"""

import sqlalchemy as sa

from alembic import op

revision = "a1f4c8d9e2b7"
down_revision = "c0d1e2f3a4b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "ALTER TABLE loop_items "
            "ADD COLUMN assignee_agent_id VARCHAR(64) NOT NULL DEFAULT '' "
            "COMMENT 'Assigned project chat agent ID; empty when unassigned', "
            "ADD INDEX idx_loop_items_assignee_agent_id (assignee_agent_id)"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "ALTER TABLE loop_items "
            "DROP INDEX idx_loop_items_assignee_agent_id, "
            "DROP COLUMN assignee_agent_id"
        )
    )
