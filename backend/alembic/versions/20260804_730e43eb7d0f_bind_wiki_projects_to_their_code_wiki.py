"""bind wiki projects to their code wiki

Revision ID: 730e43eb7d0f
Revises: bd9c871a93d2

wiki_projects becomes the table that answers "which knowledge base is the wiki of
this repository", and answers it with a database constraint rather than a
check-then-insert: it settles two requests racing to create the same wiki, and it lets
COUNT(*) WHERE source_url = ? say how many wikis a repository already has without
reading a JSON field.

The row is therefore one per (repository, wiki) rather than one per repository. A
code wiki belongs to whoever created it, so a wiki built by one person is invisible to
everyone else under the ordinary knowledge-base ACL -- "one repository, one wiki"
stopped being a saving the moment ownership moved to the creator, and became a way to
take a wiki away from the second person to ask for one.

kind_id = 0 marks a project row with no code wiki, which is every row that exists
today, and legacy rows stay at most one per repository because the same constraint
gives that for free.

Adding the column and moving the UNIQUE are one migration because the state between
them cannot serve anybody: kind_id exists, and source_url is still globally
unique, so a repository still cannot have a second wiki.
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "730e43eb7d0f"
down_revision: Union[str, Sequence[str], None] = "bd9c871a93d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# MySQL names the constraint after the column it was declared on.
OLD_UNIQUE = "source_url"
NEW_UNIQUE = "uq_wiki_projects_source_url_kind_id"


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
    # Created before the old one is dropped: between the two statements the table is
    # covered by both rather than by neither, so a concurrent insert cannot slip a
    # duplicate pair in through the gap.
    op.create_unique_constraint(NEW_UNIQUE, "wiki_projects", ["source_url", "kind_id"])
    op.drop_constraint(OLD_UNIQUE, "wiki_projects", type_="unique")


def downgrade() -> None:
    """Downgrade schema.

    Restoring the single-column UNIQUE fails if any repository has more than one wiki,
    which is correct: silently discarding one of them would destroy a generated
    knowledge base. Delete the surplus wikis first if this has to be reversed.
    """
    op.create_unique_constraint(OLD_UNIQUE, "wiki_projects", ["source_url"])
    op.drop_constraint(NEW_UNIQUE, "wiki_projects", type_="unique")
    op.drop_index("ix_wiki_projects_kind_id", table_name="wiki_projects")
    op.drop_column("wiki_projects", "kind_id")
