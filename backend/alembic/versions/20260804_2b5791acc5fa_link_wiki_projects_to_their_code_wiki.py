"""link wiki projects to their code wiki

Revision ID: 2b5791acc5fa
Revises: bd9c871a93d2

``wiki_projects.source_url`` is already UNIQUE, which makes this table the only place
that can enforce "one repository, one code wiki" against two people creating at the
same moment. Recording the knowledge base here, rather than checking a JSON field on
the knowledge base itself, turns a check-then-insert into a database constraint.

``0`` marks a project row with no code wiki, which is every row that exists today.
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2b5791acc5fa"
down_revision: Union[str, Sequence[str], None] = "bd9c871a93d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "wiki_projects",
        sa.Column(
            "kind_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Code wiki knowledge base built from this repository; 0 = none",
        ),
    )
    op.create_index(
        "ix_wiki_projects_kind_id", "wiki_projects", ["kind_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_wiki_projects_kind_id", table_name="wiki_projects")
    op.drop_column("wiki_projects", "kind_id")
