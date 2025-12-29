# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Add subtask_contexts table and migrate from subtask_attachments.

Revision ID: o5p6q7r8s9t0
Revises: n4o5p6q7r8s9
Create Date: 2025-12-31 12:00:00.000000

This migration:
1. Creates the new subtask_contexts table with unified context storage
2. Migrates all data from subtask_attachments to subtask_contexts
3. Drops the old subtask_attachments table

The subtask_contexts table provides a unified storage for all context types
including attachments, knowledge bases, and future context types.
"""

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

# revision identifiers, used by Alembic.
revision = "o5p6q7r8s9t0"
down_revision = "n4o5p6q7r8s9"
branch_labels = None
depends_on = None


def upgrade():
    """
    Create subtask_contexts table and migrate data from subtask_attachments.

    The subtask_contexts table provides a unified storage for all context types
    including attachments, knowledge bases, and future context types.
    """
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
        sa.Column("binary_data", mysql.LONGBLOB(), nullable=True),
        sa.Column("image_base64", mysql.LONGTEXT(), nullable=True),
        sa.Column("extracted_text", mysql.LONGTEXT(), nullable=True),
        sa.Column("text_length", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("type_data", sa.JSON(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # 2. Create indexes (only for high-cardinality fields)
    op.create_index(
        "idx_subtask_contexts_subtask_id", "subtask_contexts", ["subtask_id"]
    )
    op.create_index("idx_subtask_contexts_user_id", "subtask_contexts", ["user_id"])

    # 3. Migrate data from subtask_attachments (if table exists)
    connection = op.get_bind()

    # Check if subtask_attachments table exists
    inspector = sa.inspect(connection)
    if "subtask_attachments" in inspector.get_table_names():
        # Check if updated_at column exists in subtask_attachments
        columns = [col["name"] for col in inspector.get_columns("subtask_attachments")]
        has_updated_at = "updated_at" in columns

        # Build the updated_at expression based on column existence
        updated_at_expr = (
            "COALESCE(updated_at, created_at)" if has_updated_at else "created_at"
        )

        # Migrate data from subtask_attachments to subtask_contexts
        connection.execute(
            sa.text(
                f"""
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
                error_message,
                binary_data,
                image_base64,
                extracted_text,
                COALESCE(text_length, 0) AS text_length,
                JSON_OBJECT(
                    'original_filename', original_filename,
                    'file_extension', file_extension,
                    'file_size', file_size,
                    'mime_type', mime_type,
                    'storage_key', COALESCE(storage_key, ''),
                    'storage_backend', COALESCE(storage_backend, 'mysql')
                ) AS type_data,
                created_at,
                {updated_at_expr} AS updated_at
            FROM subtask_attachments
        """
            )
        )

        # 4. Drop old table
        op.drop_table("subtask_attachments")


def downgrade():
    """
    Recreate subtask_attachments table and migrate data back.
    """
    # 1. Recreate subtask_attachments table
    op.create_table(
        "subtask_attachments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("subtask_id", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("file_extension", sa.String(20), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        sa.Column("binary_data", mysql.LONGBLOB(), nullable=True),
        sa.Column("storage_key", sa.String(500), nullable=True),
        sa.Column(
            "storage_backend", sa.String(50), nullable=False, server_default="mysql"
        ),
        sa.Column("image_base64", mysql.LONGTEXT(), nullable=True),
        sa.Column("extracted_text", mysql.LONGTEXT(), nullable=True),
        sa.Column("text_length", sa.Integer(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("uploading", "parsing", "ready", "failed", name="attachmentstatus"),
            nullable=False,
        ),
        sa.Column("error_message", sa.String(500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    # 2. Create indexes for subtask_attachments
    op.create_index(
        "idx_subtask_attachments_subtask_id", "subtask_attachments", ["subtask_id"]
    )
    op.create_index(
        "idx_subtask_attachments_user_id", "subtask_attachments", ["user_id"]
    )

    # 3. Migrate data back from subtask_contexts (only attachment type)
    # Note: Convert 'pending' status to 'uploading' since AttachmentStatus doesn't have 'pending'
    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
        INSERT INTO subtask_attachments (
            subtask_id, user_id, original_filename, file_extension, file_size, mime_type,
            binary_data, storage_key, storage_backend, image_base64, extracted_text,
            text_length, status, error_message, created_at, updated_at
        )
        SELECT
            subtask_id,
            user_id,
            JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.original_filename')) AS original_filename,
            JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.file_extension')) AS file_extension,
            CAST(JSON_EXTRACT(type_data, '$.file_size') AS SIGNED) AS file_size,
            JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.mime_type')) AS mime_type,
            binary_data,
            JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.storage_key')) AS storage_key,
            JSON_UNQUOTE(JSON_EXTRACT(type_data, '$.storage_backend')) AS storage_backend,
            image_base64,
            extracted_text,
            text_length,
            CASE
                WHEN status = 'pending' THEN 'uploading'
                ELSE status
            END AS status,
            error_message,
            created_at,
            updated_at
        FROM subtask_contexts
        WHERE context_type = 'attachment'
    """
        )
    )

    # 4. Drop subtask_contexts table
    op.drop_index("idx_subtask_contexts_user_id", table_name="subtask_contexts")
    op.drop_index("idx_subtask_contexts_subtask_id", table_name="subtask_contexts")
    op.drop_table("subtask_contexts")
