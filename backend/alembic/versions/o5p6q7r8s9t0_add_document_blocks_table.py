"""add_document_blocks_table

Revision ID: o5p6q7r8s9t0
Revises: n4o5p6q7r8s9
Create Date: 2025-12-31 10:00:00.000000+08:00

This migration creates the 'document_blocks' table for storing parsed
document blocks used in document preview, editing, and RAG support.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "o5p6q7r8s9t0"
down_revision: Union[str, Sequence[str], None] = "n4o5p6q7r8s9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create document_blocks table."""
    op.create_table(
        "document_blocks",
        sa.Column("id", sa.String(36), primary_key=True, comment="Primary key (UUID)"),
        sa.Column(
            "document_id",
            sa.String(36),
            nullable=False,
            index=True,
            comment="Reference to uploaded document",
        ),
        sa.Column(
            "block_type",
            sa.String(50),
            nullable=False,
            comment="Block type: paragraph, heading, image, table, code, ai_summary, unsupported, list",
        ),
        sa.Column(
            "content",
            sa.Text,
            nullable=True,
            comment="Text content or image description",
        ),
        sa.Column(
            "editable",
            sa.Boolean,
            default=False,
            comment="Whether user can edit this block",
        ),
        sa.Column(
            "order_index",
            sa.Integer,
            nullable=False,
            comment="Order within document",
        ),
        sa.Column(
            "source_ref",
            sa.JSON,
            nullable=True,
            comment="Source reference: {page, line, offset, bbox, etc.}",
        ),
        sa.Column(
            "metadata",
            sa.JSON,
            nullable=True,
            comment="Block metadata: {image_url, ocr_text, lang, level, etc.}",
        ),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            comment="Update time",
        ),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    # Create index on document_id for efficient queries
    op.create_index(
        "ix_document_blocks_document_id",
        "document_blocks",
        ["document_id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop document_blocks table."""
    op.drop_index("ix_document_blocks_document_id", table_name="document_blocks")
    op.drop_table("document_blocks")
