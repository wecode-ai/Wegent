"""Backfill project-owned Team definitions under each original source identity."""

import logging

from alembic import op
from sqlalchemy.orm import Session

from app.services.project_agent_teams import migrate

revision = "ac7e491bf026"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with Session(op.get_bind()) as session:
        counts = migrate(session, commit_batches=False)
        logging.getLogger("alembic").info("Project Agent Team upgrade %s", counts)


def downgrade() -> None:
    with Session(op.get_bind()) as session:
        counts = migrate(session, rollback=True, commit_batches=False)
        logging.getLogger("alembic").info("Project Agent Team downgrade %s", counts)
