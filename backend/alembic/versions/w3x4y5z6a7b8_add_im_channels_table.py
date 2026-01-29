# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add im_channels table

Revision ID: w3x4y5z6a7b8
Revises: v2w3x4y5z6a7
Create Date: 2025-01-28

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "w3x4y5z6a7b8"
down_revision: Union[str, None] = "v2w3x4y5z6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create im_channels table for IM platform integrations (DingTalk, Feishu, WeChat)
    op.execute(
        """
        CREATE TABLE im_channels (
            id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key ID',
            name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Channel display name',
            channel_type VARCHAR(50) NOT NULL DEFAULT 'dingtalk' COMMENT 'Channel type: dingtalk/feishu/wechat',
            is_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether channel is enabled',
            config JSON NOT NULL COMMENT 'Channel configuration in JSON format',
            default_team_id INT NOT NULL DEFAULT 0 COMMENT 'Default team ID for messages from this channel, 0 means none',
            default_model_name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Default model name to override bot model, empty means use bot default',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time',
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Record update time',
            create_user_id INT NOT NULL DEFAULT 0 COMMENT 'User ID who created this channel, 0 means system',
            INDEX idx_im_channels_id (id),
            INDEX idx_im_channels_channel_type (channel_type),
            INDEX idx_im_channels_is_enabled (is_enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS im_channels")
