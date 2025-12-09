"""add shared_tasks table for task sharing

Revision ID: d3e4f5a6b7c8
Revises: f5a6b7c8d9e0
Create Date: 2025-12-04 12:00:00.000000+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3e4f5a6b7c8"
down_revision: Union[str, Sequence[str], None] = "f5a6b7c8d9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add shared_tasks table for task sharing functionality."""

    # Create shared_tasks table
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS shared_tasks (
        id INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
        user_id INT NOT NULL DEFAULT 0 COMMENT '当前用户ID',
        original_user_id INT NOT NULL DEFAULT 0 COMMENT '原始任务所有者用户ID',
        original_task_id INT NOT NULL DEFAULT 0 COMMENT '原始任务ID',
        copied_task_id INT NOT NULL DEFAULT 0 COMMENT '复制后的任务ID',
        is_active BOOLEAN NOT NULL DEFAULT TRUE COMMENT '是否激活',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (id),
        KEY idx_shared_tasks_id (id),
        KEY idx_shared_tasks_user_id (user_id),
        KEY idx_shared_tasks_original_user_id (original_user_id),
        KEY idx_shared_tasks_original_task_id (original_task_id),
        KEY idx_shared_tasks_copied_task_id (copied_task_id),
        UNIQUE KEY uniq_user_original_task (user_id, original_task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """
    )


def downgrade() -> None:
    """Remove shared_tasks table."""
    op.execute("DROP TABLE IF EXISTS shared_tasks")