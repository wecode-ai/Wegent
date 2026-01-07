# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Migrate public_models and public_shells to kinds table

Revision ID: h8i9j0k1l2m3
Revises: g7h8i9j0k1l2
Create Date: 2025-12-09 22:10:00.000000+08:00

This migration:
1. Migrates all records from public_models to kinds table (user_id=0, kind='Model', namespace='default')
2. Migrates all records from public_shells to kinds table (user_id=0, kind='Shell', namespace='default')
3. Drops public_models and public_shells tables
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "h8i9j0k1l2m3"
down_revision: Union[str, None] = "g7h8i9j0k1l2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Migrate public_models and public_shells to kinds table.

    The public_models and public_shells tables use a simplified schema with a 'json' column
    that stores all resource data. This migration:
    1. Migrates data from public_models to kinds (user_id=0, kind='Model')
    2. Migrates data from public_shells to kinds (user_id=0, kind='Shell')
    3. Drops the old tables
    """

    # Migrate public_models to kinds
    # The 'json' column in public_models contains the full spec data
    op.execute(
        """
        INSERT INTO kinds (user_id, kind, namespace, name, json, is_active, created_at, updated_at)
        SELECT
            0 as user_id,
            'Model' as kind,
            namespace,
            name,
            json,
            is_active,
            created_at,
            updated_at
        FROM public_models
        WHERE NOT EXISTS (
            SELECT 1 FROM kinds
            WHERE kinds.user_id = 0
            AND kinds.kind = 'Model'
            AND kinds.namespace = public_models.namespace
            AND kinds.name = public_models.name
        )
    """
    )

    # Migrate public_shells to kinds
    # The 'json' column in public_shells contains the full spec data
    op.execute(
        """
        INSERT INTO kinds (user_id, kind, namespace, name, json, is_active, created_at, updated_at)
        SELECT
            0 as user_id,
            'Shell' as kind,
            namespace,
            name,
            json,
            is_active,
            created_at,
            updated_at
        FROM public_shells
        WHERE NOT EXISTS (
            SELECT 1 FROM kinds
            WHERE kinds.user_id = 0
            AND kinds.kind = 'Shell'
            AND kinds.namespace = public_shells.namespace
            AND kinds.name = public_shells.name
        )
    """
    )

    # Drop old tables
    op.execute("DROP TABLE IF EXISTS public_shells")
    op.execute("DROP TABLE IF EXISTS public_models")


def downgrade() -> None:
    """Restore public_models and public_shells tables with simplified schema."""

    # Recreate public_models table with simplified schema
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public_models (
            id INT NOT NULL AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            namespace VARCHAR(100) NOT NULL DEFAULT 'default',
            json JSON NOT NULL COMMENT 'Resource-specific data in JSON format',
            is_active BOOLEAN DEFAULT TRUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY ix_public_models_id (id),
            UNIQUE KEY idx_public_model_name_namespace (name, namespace)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """
    )

    # Recreate public_shells table with simplified schema
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public_shells (
            id INT NOT NULL AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            namespace VARCHAR(100) NOT NULL DEFAULT 'default',
            json JSON NOT NULL COMMENT 'Resource-specific data in JSON format',
            is_active BOOLEAN DEFAULT TRUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY ix_public_shells_id (id),
            UNIQUE KEY idx_public_shell_name_namespace (name, namespace)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """
    )

    # Migrate data back from kinds to public_models
    op.execute(
        """
        INSERT INTO public_models (name, namespace, json, is_active, created_at, updated_at)
        SELECT
            name,
            namespace,
            json,
            is_active,
            created_at,
            updated_at
        FROM kinds
        WHERE user_id = 0 AND kind = 'Model'
    """
    )

    # Migrate data back from kinds to public_shells
    op.execute(
        """
        INSERT INTO public_shells (name, namespace, json, is_active, created_at, updated_at)
        SELECT
            name,
            namespace,
            json,
            is_active,
            created_at,
            updated_at
        FROM kinds
        WHERE user_id = 0 AND kind = 'Shell'
    """
    )

    # Remove migrated records from kinds
    op.execute("DELETE FROM kinds WHERE user_id = 0 AND kind = 'Model'")
    op.execute("DELETE FROM kinds WHERE user_id = 0 AND kind = 'Shell'")
