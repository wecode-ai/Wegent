"""allow several wikis per repository

Revision ID: c3d4e5f6a7b8
Revises: 2b5791acc5fa

A code wiki belongs to whoever created it, so a wiki built by one person is invisible
to everyone else under the ordinary knowledge-base ACL. "One repository, one wiki"
therefore stopped being a saving and became a way to take a wiki away from the second
person to ask for one.

``wiki_projects`` accordingly holds one row per ``(repository, wiki)`` rather than one
per repository. The UNIQUE moves from ``source_url`` alone to the pair, which is still
a database constraint rather than a check-then-insert: it settles two requests racing
for the same pair, and it lets ``COUNT(*) WHERE source_url = ?`` answer "how many
wikis already exist for this repository" without reading a JSON field.

Legacy wiki rows carry ``kind_id = 0`` and stay at most one per repository, which the
same constraint gives for free.
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, Sequence[str], None] = "2b5791acc5fa"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# MySQL names the constraint after the column it was declared on.
OLD_UNIQUE = "source_url"
NEW_UNIQUE = "uq_wiki_projects_source_url_kind_id"


def upgrade() -> None:
    """Upgrade schema."""
    # Created before the old one is dropped: between the two statements the table is
    # covered by both rather than by neither, so a concurrent insert cannot slip a
    # duplicate pair in through the gap.
    op.create_unique_constraint(NEW_UNIQUE, "wiki_projects", ["source_url", "kind_id"])
    op.drop_constraint(OLD_UNIQUE, "wiki_projects", type_="unique")


def downgrade() -> None:
    """Downgrade schema.

    Fails if any repository has more than one wiki, which is correct: silently
    discarding one of them would destroy a generated knowledge base. Delete the
    surplus wikis first if this has to be reversed.
    """
    op.create_unique_constraint(OLD_UNIQUE, "wiki_projects", ["source_url"])
    op.drop_constraint(NEW_UNIQUE, "wiki_projects", type_="unique")
