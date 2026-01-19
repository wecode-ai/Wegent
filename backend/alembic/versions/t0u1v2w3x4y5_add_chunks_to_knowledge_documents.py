# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add chunks to knowledge_documents

Revision ID: t0u1v2w3x4y5
Revises: s9t0u1v2w3x4
Create Date: 2025-01-19 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "t0u1v2w3x4y5"
down_revision: Union[str, None] = "s9t0u1v2w3x4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add chunks column to knowledge_documents table
    # This column stores chunk data only for structural_semantic splitter
    op.add_column(
        "knowledge_documents",
        sa.Column("chunks", sa.JSON(), nullable=True, default=None),
    )


def downgrade() -> None:
    # Remove chunks column from knowledge_documents table
    op.drop_column("knowledge_documents", "chunks")
