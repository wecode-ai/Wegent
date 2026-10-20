"""Make the existing account-auth policy a unique optimistic business parent.

Revision ID: b9d8e7a6c501
Revises: f3a7c9e1b2d4
Create Date: 2026-10-20
"""

import sqlalchemy as sa

from alembic import op

revision = "b9d8e7a6c501"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None

INDEX_NAME = "uq_kinds_account_auth_policy"
EXPRESSION = (
    "(CASE WHEN kind = 'ConnectorAuthPolicy' "
    "AND namespace = 'plugin-auth' AND name = 'account' "
    "THEN user_id ELSE NULL END)"
)


def upgrade() -> None:
    # Do not silently choose a winner for conflicting authentication policies.
    duplicates = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT user_id FROM kinds WHERE kind = 'ConnectorAuthPolicy' "
                "AND namespace = 'plugin-auth' AND name = 'account' "
                "GROUP BY user_id HAVING COUNT(*) > 1 LIMIT 1"
            )
        )
        .first()
    )
    if duplicates is not None:
        raise RuntimeError("Duplicate account-auth policies require reconciliation")
    op.create_index(INDEX_NAME, "kinds", [sa.text(EXPRESSION)], unique=True)


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="kinds")
