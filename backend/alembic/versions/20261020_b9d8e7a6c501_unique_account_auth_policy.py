"""Retain the retired account-auth index migration in the revision chain.

Revision ID: b9d8e7a6c501
Revises: f3a7c9e1b2d4
Create Date: 2026-10-20
"""

revision = "b9d8e7a6c501"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Previously applied revisions must remain resolvable. A subsequent
    # migration removes the retired index only where it was already created.
    pass


def downgrade() -> None:
    pass
