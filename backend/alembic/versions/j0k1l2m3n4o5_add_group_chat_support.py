# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add group chat support: task_members table and subtask sender fields

Revision ID: j0k1l2m3n4o5
Revises: i9j0k1l2m3n4
Create Date: 2025-12-17 10:00:00.000000+08:00

This migration adds support for group chat functionality:
1. Creates task_members table to store group chat participants
2. Adds sender fields to subtasks table for identifying message authors
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "j0k1l2m3n4o5"
down_revision: Union[str, None] = "i9j0k1l2m3n4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create task_members table and add sender fields to subtasks."""
    # Create task_members table for group chat participants
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS task_members (
        id INT NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
        task_id INT NOT NULL DEFAULT 0 COMMENT 'Related Task Kind.id',
        user_id INT NOT NULL DEFAULT 0 COMMENT 'Member user ID',
        invited_by INT NOT NULL DEFAULT 0 COMMENT 'Inviter user ID',
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' COMMENT 'Member status: ACTIVE or REMOVED',
        joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Join timestamp',
        removed_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00' COMMENT 'Removal timestamp, default epoch time for not removed',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation timestamp',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
        PRIMARY KEY (id),
        UNIQUE KEY uniq_task_member (task_id, user_id),
        KEY idx_task_members_task_id (task_id),
        KEY idx_task_members_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """
    )

    # Add sender fields to subtasks table for group chat support
    op.execute(
        """
    ALTER TABLE subtasks
    ADD COLUMN sender_type VARCHAR(20) DEFAULT NULL COMMENT 'Sender type: USER or TEAM' AFTER completed_at,
    ADD COLUMN sender_user_id INT DEFAULT NULL COMMENT 'User ID when sender_type=USER' AFTER sender_type,
    ADD COLUMN reply_to_subtask_id INT DEFAULT NULL COMMENT 'Quoted message ID for reply feature' AFTER sender_user_id
    """
    )


def downgrade() -> None:
    """Drop task_members table and remove sender fields from subtasks."""
    # Remove sender fields from subtasks table
    op.execute(
        """
    ALTER TABLE subtasks
    DROP COLUMN sender_type,
    DROP COLUMN sender_user_id,
    DROP COLUMN reply_to_subtask_id
    """
    )

    # Drop task_members table
    op.execute("DROP TABLE IF EXISTS task_members")
