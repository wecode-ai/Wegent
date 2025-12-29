# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Migrate subtask_attachments to subtask_contexts

Revision ID: n4o5p6q7r8s9
Revises: l2m3n4o5p6q7
Create Date: 2025-12-29

This migration:
1. Creates the subtask_contexts table with unified context storage
2. Migrates existing data from subtask_attachments
3. Drops the old subtask_attachments table
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.mysql import LONGBLOB, LONGTEXT

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "n4o5p6q7r8s9"
down_revision: Union[str, None] = "l2m3n4o5p6q7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create subtask_contexts table and migrate data from subtask_attachments."""
    # 1. Create subtask_contexts table
    op.create_table(
        "subtask_contexts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("subtask_id", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("context_type", sa.String(50), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("binary_data", LONGBLOB(), nullable=True),
        sa.Column("image_base64", LONGTEXT(), nullable=True),
        sa.Column("extracted_text", LONGTEXT(), nullable=True),
        sa.Column("text_length", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("type_data", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )

    # 2. Create indexes
    op.create_index("idx_subtask_contexts_id", "subtask_contexts", ["id"])
    op.create_index("idx_subtask_contexts_subtask_id", "subtask_contexts", ["subtask_id"])
    op.create_index("idx_subtask_contexts_user_id", "subtask_contexts", ["user_id"])
    op.create_index("idx_subtask_contexts_context_type", "subtask_contexts", ["context_type"])
    op.create_index("idx_subtask_contexts_status", "subtask_contexts", ["status"])

    # 3. Migrate data from subtask_attachments to subtask_contexts
    # Using raw SQL for complex JSON construction
    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
        INSERT INTO subtask_contexts (
            subtask_id, user_id, context_type, name, status, error_message,
            binary_data, image_base64, extracted_text, text_length,
            type_data, created_at, updated_at
        )
        SELECT
            subtask_id,
            user_id,
            'attachment' AS context_type,
            original_filename AS name,
            status,
            NULLIF(error_message, '') AS error_message,
            binary_data,
            image_base64,
            extracted_text,
            COALESCE(text_length, 0),
            JSON_OBJECT(
                'original_filename', original_filename,
                'file_extension', file_extension,
                'file_size', file_size,
                'mime_type', mime_type,
                'storage_key', COALESCE(storage_key, ''),
                'storage_backend', COALESCE(storage_backend, 'mysql')
            ) AS type_data,
            created_at,
            COALESCE(created_at, NOW()) AS updated_at
        FROM subtask_attachments
    """
        )
    )

    # 4. Drop the old table
    op.drop_table("subtask_attachments")


def downgrade() -> None:
    """Recreate subtask_attachments table and migrate data back."""
    # 1. Recreate subtask_attachments table
    op.create_table(
        "subtask_attachments",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        sa.Column("subtask_id", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("file_extension", sa.String(20), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        sa.Column("binary_data", LONGBLOB(), nullable=False),
        sa.Column("storage_key", sa.String(500), nullable=False, server_default=""),
        sa.Column("storage_backend", sa.String(50), nullable=False, server_default="mysql"),
        sa.Column("image_base64", LONGTEXT(), nullable=True),
        sa.Column("extracted_text", LONGTEXT(), nullable=True),
        sa.Column("text_length", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "status",
            sa.Enum("uploading", "parsing", "ready", "failed", name="attachmentstatus"),
            nullable=False,
        ),
        sa.Column("error_message", sa.String(500), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )

    # 2. Create indexes
    op.create_index("ix_subtask_attachments_id", "subtask_attachments", ["id"])
    op.create_index("ix_subtask_attachments_subtask_id", "subtask_attachments", ["subtask_id"])
    op.create_index("ix_subtask_attachments_user_id", "subtask_attachments", ["user_id"])

    # 3. Migrate data back from subtask_contexts (only attachment type)
    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
        INSERT INTO subtask_attachments (
            subtask_id, user_id, original_filename, file_extension, file_size,
            mime_type, binary_data, storage_key, storage_backend,
            image_base64, extracted_text, text_length, status, error_message, created_at
        )
        SELECT
            subtask_id,
            user_id,
            JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.original_filename')) AS original_filename,
            JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.file_extension')) AS file_extension,
            CAST(JSON_EXTRACT(type_data, '$.file_size') AS UNSIGNED) AS file_size,
            JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.mime_type')) AS mime_type,
            COALESCE(binary_data, '') AS binary_data,
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.storage_key')), '') AS storage_key,
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.storage_backend')), 'mysql') AS storage_backend,
            image_base64,
            extracted_text,
            COALESCE(text_length, 0),
            status,
            COALESCE(error_message, '') AS error_message,
            created_at
        FROM subtask_contexts
        WHERE context_type = 'attachment'
    """
        )
    )

    # 4. Drop subtask_contexts table
    op.drop_table("subtask_contexts")
