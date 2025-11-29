"""add completion_conditions table for async team mode CI monitoring

Revision ID: 2b3c4d5e6f7g
Revises: 1a2b3c4d5e6f
Create Date: 2025-07-15 10:00:00.000000+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2b3c4d5e6f7g'
down_revision: Union[str, Sequence[str], None] = '1a2b3c4d5e6f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add completion_conditions table for tracking async completion conditions."""

    # Create completion_conditions table
    op.execute("""
    CREATE TABLE IF NOT EXISTS completion_conditions (
        id INT NOT NULL AUTO_INCREMENT,
        subtask_id INT NOT NULL,
        task_id INT NOT NULL,
        user_id INT NOT NULL,
        condition_type ENUM('CI_PIPELINE') NOT NULL DEFAULT 'CI_PIPELINE',
        status ENUM('PENDING', 'IN_PROGRESS', 'SATISFIED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
        trigger_type VARCHAR(50),
        external_id VARCHAR(255),
        external_url VARCHAR(1024),
        git_platform ENUM('GITHUB', 'GITLAB'),
        git_domain VARCHAR(255),
        repo_full_name VARCHAR(512),
        branch_name VARCHAR(255),
        retry_count INT NOT NULL DEFAULT 0,
        max_retries INT NOT NULL DEFAULT 5,
        last_failure_log TEXT,
        session_id VARCHAR(255),
        executor_namespace VARCHAR(100),
        executor_name VARCHAR(100),
        metadata JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        satisfied_at DATETIME,
        PRIMARY KEY (id),
        KEY ix_completion_conditions_id (id),
        KEY ix_completion_conditions_subtask_id (subtask_id),
        KEY ix_completion_conditions_task_id (task_id),
        KEY ix_completion_conditions_user_id (user_id),
        KEY ix_completion_conditions_repo_branch (repo_full_name, branch_name),
        KEY ix_completion_conditions_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)


def downgrade() -> None:
    """Remove completion_conditions table."""
    op.execute("DROP TABLE IF EXISTS completion_conditions")
