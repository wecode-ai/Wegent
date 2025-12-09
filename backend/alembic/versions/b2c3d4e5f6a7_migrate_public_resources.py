# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Migrate public_models and public_shells to kinds table

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2025-12-09 22:10:00.000000+08:00

This migration:
1. Migrates all records from public_models to kinds table (user_id=0, kind='Model', namespace='default')
2. Migrates all records from public_shells to kinds table (user_id=0, kind='Shell', namespace='default')
3. Drops public_models and public_shells tables
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Migrate public_models and public_shells to kinds table."""

    # Migrate public_models to kinds
    op.execute(
        """
        INSERT INTO kinds (user_id, kind, namespace, name, spec, labels, created_at, updated_at)
        SELECT
            0 as user_id,
            'Model' as kind,
            'default' as namespace,
            name,
            JSON_OBJECT(
                'modelConfig', JSON_OBJECT(
                    'modelName', model_name,
                    'apiKey', api_key,
                    'baseUrl', base_url,
                    'maxTokens', max_tokens,
                    'temperature', temperature
                ),
                'isCustomConfig', is_custom_config,
                'protocol', protocol
            ) as spec,
            JSON_OBJECT() as labels,
            created_at,
            updated_at
        FROM public_models
        WHERE NOT EXISTS (
            SELECT 1 FROM kinds
            WHERE kinds.user_id = 0
            AND kinds.kind = 'Model'
            AND kinds.namespace = 'default'
            AND kinds.name = public_models.name
        )
        """
    )

    # Migrate public_shells to kinds
    op.execute(
        """
        INSERT INTO kinds (user_id, kind, namespace, name, spec, labels, created_at, updated_at)
        SELECT
            0 as user_id,
            'Shell' as kind,
            'default' as namespace,
            name,
            JSON_OBJECT(
                'shellType', shell_type,
                'supportModel', support_model,
                'baseImage', base_image,
                'baseShellRef', base_shell_ref
            ) as spec,
            JSON_OBJECT() as labels,
            created_at,
            updated_at
        FROM public_shells
        WHERE NOT EXISTS (
            SELECT 1 FROM kinds
            WHERE kinds.user_id = 0
            AND kinds.kind = 'Shell'
            AND kinds.namespace = 'default'
            AND kinds.name = public_shells.name
        )
        """
    )

    # Drop old tables
    op.drop_table('public_shells')
    op.drop_table('public_models')


def downgrade() -> None:
    """Restore public_models and public_shells tables."""

    # Recreate public_models table
    op.execute(
        """
        CREATE TABLE `public_models` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
          `model_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
          `api_key` text COLLATE utf8mb4_unicode_ci,
          `base_url` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
          `max_tokens` int(11) DEFAULT NULL,
          `temperature` float DEFAULT NULL,
          `is_custom_config` tinyint(1) DEFAULT '0',
          `protocol` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT 'openai',
          `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
          `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          UNIQUE KEY `idx_public_model_name_unique` (`name`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
    )

    # Recreate public_shells table
    op.execute(
        """
        CREATE TABLE `public_shells` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
          `shell_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
          `support_model` text COLLATE utf8mb4_unicode_ci,
          `base_image` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
          `base_shell_ref` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
          `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
          `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          UNIQUE KEY `idx_public_shell_name_unique` (`name`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
    )

    # Migrate data back from kinds to public_models
    op.execute(
        """
        INSERT INTO public_models (name, model_name, api_key, base_url, max_tokens, temperature, is_custom_config, protocol, created_at, updated_at)
        SELECT
            name,
            JSON_UNQUOTE(JSON_EXTRACT(spec, '$.modelConfig.modelName')) as model_name,
            JSON_UNQUOTE(JSON_EXTRACT(spec, '$.modelConfig.apiKey')) as api_key,
            JSON_UNQUOTE(JSON_EXTRACT(spec, '$.modelConfig.baseUrl')) as base_url,
            JSON_EXTRACT(spec, '$.modelConfig.maxTokens') as max_tokens,
            JSON_EXTRACT(spec, '$.modelConfig.temperature') as temperature,
            JSON_EXTRACT(spec, '$.isCustomConfig') as is_custom_config,
            JSON_UNQUOTE(JSON_EXTRACT(spec, '$.protocol')) as protocol,
            created_at,
            updated_at
        FROM kinds
        WHERE user_id = 0 AND kind = 'Model' AND namespace = 'default'
        """
    )

    # Migrate data back from kinds to public_shells
    op.execute(
        """
        INSERT INTO public_shells (name, shell_type, support_model, base_image, base_shell_ref, created_at, updated_at)
        SELECT
            name,
            JSON_UNQUOTE(JSON_EXTRACT(spec, '$.shellType')) as shell_type,
            JSON_UNQUOTE(JSON_EXTRACT(spec, '$.supportModel')) as support_model,
            JSON_UNQUOTE(JSON_EXTRACT(spec, '$.baseImage')) as base_image,
            JSON_UNQUOTE(JSON_EXTRACT(spec, '$.baseShellRef')) as base_shell_ref,
            created_at,
            updated_at
        FROM kinds
        WHERE user_id = 0 AND kind = 'Shell' AND namespace = 'default'
        """
    )

    # Remove migrated records from kinds
    op.execute("DELETE FROM kinds WHERE user_id = 0 AND kind = 'Model' AND namespace = 'default'")
    op.execute("DELETE FROM kinds WHERE user_id = 0 AND kind = 'Shell' AND namespace = 'default'")
