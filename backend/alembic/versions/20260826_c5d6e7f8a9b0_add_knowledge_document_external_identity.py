# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add knowledge document external identity

Revision ID: c5d6e7f8a9b0
Revises: 7a4c2e9f1b30
Create Date: 2026-08-26

Adds external_provider / external_resource_id to knowledge_documents so an
imported external document carries its provider identity. The two columns are
both NULL (regular documents) or both set (external documents), enforced by
the document creation service rather than a database CHECK; together with
kind_id they form the unique identity of an external document inside one
knowledge base. No import-task table is introduced — external imports reuse
the existing document indexing state machine.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "c5d6e7f8a9b0"
down_revision = "7a4c2e9f1b30"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "knowledge_documents",
        sa.Column("external_provider", sa.String(32), nullable=True),
    )
    op.add_column(
        "knowledge_documents",
        sa.Column("external_resource_id", sa.String(255), nullable=True),
    )
    op.create_index(
        "uq_knowledge_documents_external",
        "knowledge_documents",
        ["kind_id", "external_provider", "external_resource_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_knowledge_documents_external", table_name="knowledge_documents")
    op.drop_column("knowledge_documents", "external_resource_id")
    op.drop_column("knowledge_documents", "external_provider")
