# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add knowledge document external identity

Revision ID: c5d6e7f8a9b0
Revises: 7a4c2e9f1b30
Create Date: 2026-08-26

Stores only external document identities in a separate table. Ordinary
documents have no identity row. This unreleased revision replaces the earlier
nullable-column migration; test installations must downgrade with the old
migration files before upgrading. No snapshot or import-task table is introduced.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "c5d6e7f8a9b0"
down_revision = "7a4c2e9f1b30"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "knowledge_document_external_sources",
        sa.Column(
            "document_id",
            sa.Integer(),
            primary_key=True,
            autoincrement=False,
            comment="知识文档ID，关联knowledge_documents.id",
        ),
        sa.Column(
            "kind_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="所属知识库ID，与知识文档的kind_id一致",
        ),
        sa.Column(
            "external_provider",
            sa.String(32),
            nullable=False,
            server_default="",
            comment="外部文档来源标识，如dingtalk；业务写入时不能为空",
        ),
        sa.Column(
            "external_resource_id",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="外部来源中的文档资源ID；业务写入时不能为空",
        ),
        sa.UniqueConstraint(
            "kind_id",
            "external_provider",
            "external_resource_id",
            name="uniq_knowledge_documents_external",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        comment="知识文档外部身份表，仅外部导入文档有记录",
    )


def downgrade() -> None:
    op.drop_table("knowledge_document_external_sources")
