# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add project-level member responsibilities and capabilities.

Revision ID: b7c8d9e0f1a2
Revises: f5e4d3c2b1a0
Create Date: 2026-08-13
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, Sequence[str], None] = "f5e4d3c2b1a0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "resource_members",
        sa.Column(
            "description",
            sa.String(2000),
            nullable=False,
            server_default="",
            comment="Project-level responsibilities and capabilities",
        ),
    )


def downgrade() -> None:
    op.drop_column("resource_members", "description")
