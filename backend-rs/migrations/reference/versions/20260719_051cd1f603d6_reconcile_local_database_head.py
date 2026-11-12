"""Reconcile the former local PR database head with the shared migration chain.

Revision ID: 051cd1f603d6
Revises: d5e6f7a8b9c0
Create Date: 2026-07-19

The PR development database was stamped with this revision after the task ID
BIGINT migration, but the corresponding local migration file was not retained.
Its schema changes are already represented by the current SQLAlchemy metadata.
Keeping the revision as an explicit no-op bridge lets existing developer
databases migrate normally without an unsafe manual stamp.
"""

from typing import Sequence, Union

revision: str = "051cd1f603d6"
down_revision: Union[str, None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
