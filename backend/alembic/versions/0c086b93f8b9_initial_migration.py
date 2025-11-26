"""initial_migration

Revision ID: 0c086b93f8b9
Revises:
Create Date: 2025-11-25 21:13:27.348617+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

# revision identifiers, used by Alembic.
revision: str = '0c086b93f8b9'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema - Create all tables if they don't exist."""

    # Create users table
    op.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INT NOT NULL AUTO_INCREMENT,
        user_name VARCHAR(50) NOT NULL,
        password_hash VARCHAR(256) NOT NULL,
        email VARCHAR(100),
        git_info JSON,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY (user_name),
        KEY ix_users_id (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # Create kinds table
    op.execute("""
    CREATE TABLE IF NOT EXISTS kinds (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        kind VARCHAR(50) NOT NULL,
        name VARCHAR(100) NOT NULL,
        namespace VARCHAR(100) NOT NULL DEFAULT 'default',
        json JSON NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_kinds_id (id),
        KEY ix_kinds_kind (kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # Create subtasks table
    op.execute("""
    CREATE TABLE IF NOT EXISTS subtasks (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        task_id INT NOT NULL,
        team_id INT NOT NULL,
        title VARCHAR(256) NOT NULL,
        bot_ids JSON NOT NULL,
        role ENUM('USER', 'ASSISTANT') NOT NULL DEFAULT 'ASSISTANT',
        executor_namespace VARCHAR(100),
        executor_name VARCHAR(100),
        executor_deleted_at BOOLEAN NOT NULL DEFAULT FALSE,
        prompt TEXT,
        message_id INT NOT NULL DEFAULT 1,
        parent_id INT,
        status ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETE') NOT NULL DEFAULT 'PENDING',
        progress INT NOT NULL DEFAULT 0,
        result JSON,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        completed_at DATETIME,
        PRIMARY KEY (id),
        KEY ix_subtasks_id (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # Create shared_teams table
    op.execute("""
    CREATE TABLE IF NOT EXISTS shared_teams (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        original_user_id INT NOT NULL,
        team_id INT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_shared_teams_id (id),
        KEY ix_shared_teams_user_id (user_id),
        KEY ix_shared_teams_original_user_id (original_user_id),
        KEY ix_shared_teams_team_id (team_id),
        UNIQUE KEY idx_user_team (user_id, team_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # Create public_models table
    op.execute("""
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
    """)

    # Create public_shells table
    op.execute("""
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
    """)


def downgrade() -> None:
    """Downgrade schema - Drop all tables."""
    op.drop_table('public_shells')
    op.drop_table('public_models')
    op.drop_table('shared_teams')
    op.drop_table('subtasks')
    op.drop_table('kinds')
    op.drop_table('users')

