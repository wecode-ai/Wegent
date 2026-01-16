# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add splitter_config to knowledge_documents

Revision ID: l2m3n4o5p6q7
Revises: k1l2m3n4o5p6
Create Date: 2025-12-22 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "l2m3n4o5p6q7"
down_revision: Union[str, None] = "56b6ed7610fe"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add splitter_config JSON column to knowledge_documents table"""
    op.add_column(
        "knowledge_documents", sa.Column("splitter_config", sa.JSON, nullable=True)
    )


def downgrade() -> None:
    """Remove splitter_config column from knowledge_documents table"""
    op.drop_column("knowledge_documents", "splitter_config")
