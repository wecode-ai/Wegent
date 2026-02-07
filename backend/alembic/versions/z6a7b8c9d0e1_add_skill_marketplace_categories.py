# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add initial skill marketplace categories

Revision ID: z6a7b8c9d0e1
Revises: y5z6a7b8c9d0
Create Date: 2025-02-07 10:00:00.000000+08:00

This migration adds the initial skill categories for the marketplace:
- development: Development Tools
- documentation: Documentation
- data: Data Analysis
- automation: Automation
"""
import json
from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "z6a7b8c9d0e1"
down_revision: Union[str, None] = "y5z6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Initial categories to create
INITIAL_CATEGORIES = [
    {
        "name": "development",
        "displayName": "开发工具",
        "displayNameEn": "Development Tools",
        "description": "代码编写、调试、测试相关工具",
        "descriptionEn": "Tools for coding, debugging, and testing",
        "icon": "code",
        "sortOrder": 0,
    },
    {
        "name": "documentation",
        "displayName": "文档处理",
        "displayNameEn": "Documentation",
        "description": "文档生成、编辑、转换工具",
        "descriptionEn": "Document generation, editing, and conversion tools",
        "icon": "file-text",
        "sortOrder": 1,
    },
    {
        "name": "data",
        "displayName": "数据分析",
        "displayNameEn": "Data Analysis",
        "description": "数据处理、分析、可视化工具",
        "descriptionEn": "Data processing, analysis, and visualization tools",
        "icon": "bar-chart",
        "sortOrder": 2,
    },
    {
        "name": "automation",
        "displayName": "自动化",
        "displayNameEn": "Automation",
        "description": "自动化工作流和任务处理工具",
        "descriptionEn": "Workflow automation and task processing tools",
        "icon": "settings",
        "sortOrder": 3,
    },
]


def upgrade() -> None:
    """Add initial skill categories to the kinds table."""
    connection = op.get_bind()

    for cat in INITIAL_CATEGORIES:
        # Check if category already exists
        result = connection.execute(
            sa.text(
                """
                SELECT id FROM kinds
                WHERE user_id = 0
                AND kind = 'SkillCategory'
                AND name = :name
                AND namespace = 'default'
                """
            ),
            {"name": cat["name"]},
        )
        existing = result.fetchone()

        if existing:
            # Skip if already exists
            continue

        # Build category JSON
        category_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "SkillCategory",
            "metadata": {"name": cat["name"], "namespace": "default"},
            "spec": {
                "displayName": cat["displayName"],
                "displayNameEn": cat["displayNameEn"],
                "description": cat["description"],
                "descriptionEn": cat["descriptionEn"],
                "icon": cat["icon"],
                "sortOrder": cat["sortOrder"],
            },
            "status": {"state": "Available"},
        }

        now = datetime.now(timezone.utc)

        connection.execute(
            sa.text(
                """
                INSERT INTO kinds (user_id, kind, namespace, name, json, is_active, created_at, updated_at)
                VALUES (0, 'SkillCategory', 'default', :name, :json, 1, :now, :now)
                """
            ),
            {
                "name": cat["name"],
                "json": json.dumps(category_json),
                "now": now,
            },
        )


def downgrade() -> None:
    """Remove initial skill categories."""
    connection = op.get_bind()

    for cat in INITIAL_CATEGORIES:
        connection.execute(
            sa.text(
                """
                DELETE FROM kinds
                WHERE user_id = 0
                AND kind = 'SkillCategory'
                AND name = :name
                AND namespace = 'default'
                """
            ),
            {"name": cat["name"]},
        )
