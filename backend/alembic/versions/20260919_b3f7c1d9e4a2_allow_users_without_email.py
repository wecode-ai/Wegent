# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""allow users without an email address

Revision ID: b3f7c1d9e4a2
Revises: c9d4e7f1a2b3
Create Date: 2026-09-19

Service-key authentication auto-creates an impersonated user for the requested
username. Those identities have no mailbox of their own, so the account is now
created without an email instead of a synthesized ``<name>@api.auto`` address
that downstream consumers mistook for a genuine address.

This adds the nullability the User model already declares and clears the
synthesized addresses written by earlier versions.
"""

import sqlalchemy as sa

from alembic import op

revision = "b3f7c1d9e4a2"
down_revision = "c9d4e7f1a2b3"
branch_labels = None
depends_on = None

# Domain previously synthesized from the impersonated username. It is not a
# real mailbox domain, so any address under it is safe to clear.
_SYNTHETIC_EMAIL_DOMAIN = "@api.auto"


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column("email", existing_type=sa.String(100), nullable=True)
    op.execute(
        "UPDATE users SET email = NULL "
        "WHERE auth_source LIKE 'api:%' "
        f"AND email LIKE '%{_SYNTHETIC_EMAIL_DOMAIN}'"
    )


def downgrade() -> None:
    # The synthesized address cannot be reconstructed, so restore the column
    # default that the previous non-null contract relied on.
    op.execute("UPDATE users SET email = '' WHERE email IS NULL")
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column("email", existing_type=sa.String(100), nullable=False)
