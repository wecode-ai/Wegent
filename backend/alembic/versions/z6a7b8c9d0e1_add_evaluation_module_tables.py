# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add evaluation module tables

Revision ID: z6a7b8c9d0e1
Revises: y5z6a7b8c9d0
Create Date: 2025-02-12

This migration adds tables for the evaluation module:
1. wecode_eval_topics - Examination topics/categories
2. wecode_eval_topic_versions - Topic version history
3. wecode_eval_questions - Individual questions
4. wecode_eval_question_versions - Question version history
5. wecode_eval_permissions - Access control for private topics
6. wecode_eval_answers - User submissions
7. wecode_eval_grading_tasks - AI grading tasks
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "z6a7b8c9d0e1"
down_revision: Union[str, None] = "y5z6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def table_exists(table_name: str) -> bool:
    """Check if a table exists in the database."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_name = :table_name AND table_schema = DATABASE()"
        ),
        {"table_name": table_name},
    )
    return result.scalar() > 0


def upgrade() -> None:
    """Create evaluation module tables."""

    # Create wecode_eval_topics table
    if not table_exists("wecode_eval_topics"):
        op.create_table(
            "wecode_eval_topics",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("name", sa.String(200), nullable=False, comment="Topic name"),
            sa.Column(
                "creator_id", sa.Integer(), nullable=False, comment="Creator user ID"
            ),
            sa.Column(
                "visibility",
                sa.String(20),
                nullable=False,
                server_default="private",
                comment="Visibility: public/private",
            ),
            sa.Column(
                "status",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Status: 0=draft, 1=published",
            ),
            sa.Column(
                "current_version",
                sa.String(25),
                nullable=False,
                server_default="",
                comment="Current published version",
            ),
            sa.Column(
                "extra_data",
                sa.JSON(),
                nullable=False,
                comment="Extra data (description, etc.)",
            ),
            sa.Column(
                "grading_team_config",
                sa.JSON(),
                nullable=False,
                comment="Grading team configuration",
            ),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                comment="Creation time",
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
                comment="Update time",
            ),
            sa.Column(
                "is_active",
                sa.Boolean(),
                nullable=False,
                server_default="1",
                comment="Active flag",
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index(
            "idx_wecode_eval_topics_creator", "wecode_eval_topics", ["creator_id"]
        )
        op.create_index(
            "idx_wecode_eval_topics_visibility", "wecode_eval_topics", ["visibility"]
        )
        op.create_index(
            "idx_wecode_eval_topics_status", "wecode_eval_topics", ["status"]
        )

    # Create wecode_eval_topic_versions table
    if not table_exists("wecode_eval_topic_versions"):
        op.create_table(
            "wecode_eval_topic_versions",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column(
                "topic_id", sa.Integer(), nullable=False, comment="Related topic ID"
            ),
            sa.Column("version", sa.String(25), nullable=False, comment="Version string"),
            sa.Column(
                "question_snapshots",
                sa.JSON(),
                nullable=False,
                comment="Question version snapshots",
            ),
            sa.Column(
                "published_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                comment="Publication time",
            ),
            sa.Column(
                "published_by",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Publisher user ID",
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index(
            "idx_wecode_eval_topic_versions_topic",
            "wecode_eval_topic_versions",
            ["topic_id"],
        )
        op.create_index(
            "idx_wecode_eval_topic_versions_version",
            "wecode_eval_topic_versions",
            ["topic_id", "version"],
        )

    # Create wecode_eval_questions table
    if not table_exists("wecode_eval_questions"):
        op.create_table(
            "wecode_eval_questions",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column(
                "topic_id", sa.Integer(), nullable=False, comment="Related topic ID"
            ),
            sa.Column("title", sa.String(500), nullable=False, comment="Question title"),
            sa.Column(
                "content_type",
                sa.String(20),
                nullable=False,
                server_default="text",
                comment="Content type: text/url/attachment/mixed",
            ),
            sa.Column(
                "content_data",
                sa.JSON(),
                nullable=False,
                comment="Question content data",
            ),
            sa.Column(
                "status",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Status: 0=draft, 1=published",
            ),
            sa.Column(
                "current_version",
                sa.String(25),
                nullable=False,
                server_default="",
                comment="Current published version",
            ),
            sa.Column(
                "order_index",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Sort order index",
            ),
            sa.Column(
                "creator_id", sa.Integer(), nullable=False, comment="Creator user ID"
            ),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                comment="Creation time",
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
                comment="Update time",
            ),
            sa.Column(
                "is_active",
                sa.Boolean(),
                nullable=False,
                server_default="1",
                comment="Active flag",
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index(
            "idx_wecode_eval_questions_topic", "wecode_eval_questions", ["topic_id"]
        )
        op.create_index(
            "idx_wecode_eval_questions_creator", "wecode_eval_questions", ["creator_id"]
        )
        op.create_index(
            "idx_wecode_eval_questions_order",
            "wecode_eval_questions",
            ["topic_id", "order_index"],
        )

    # Create wecode_eval_question_versions table
    if not table_exists("wecode_eval_question_versions"):
        op.create_table(
            "wecode_eval_question_versions",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column(
                "question_id", sa.Integer(), nullable=False, comment="Related question ID"
            ),
            sa.Column("version", sa.String(25), nullable=False, comment="Version string"),
            sa.Column(
                "content_data",
                sa.JSON(),
                nullable=False,
                comment="Question content snapshot",
            ),
            sa.Column(
                "criteria_data",
                sa.JSON(),
                nullable=False,
                comment="Grading criteria data",
            ),
            sa.Column(
                "published_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                comment="Publication time",
            ),
            sa.Column(
                "published_by",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Publisher user ID",
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index(
            "idx_wecode_eval_question_versions_question",
            "wecode_eval_question_versions",
            ["question_id"],
        )
        op.create_index(
            "idx_wecode_eval_question_versions_ver",
            "wecode_eval_question_versions",
            ["question_id", "version"],
        )

    # Create wecode_eval_permissions table
    if not table_exists("wecode_eval_permissions"):
        op.create_table(
            "wecode_eval_permissions",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column(
                "topic_id", sa.Integer(), nullable=False, comment="Related topic ID"
            ),
            sa.Column(
                "user_id", sa.Integer(), nullable=False, comment="Authorized user ID"
            ),
            sa.Column(
                "role",
                sa.String(20),
                nullable=False,
                server_default="respondent",
                comment="Role: respondent/grader",
            ),
            sa.Column(
                "granted_by",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Granter user ID",
            ),
            sa.Column(
                "granted_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                comment="Grant time",
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index(
            "idx_wecode_eval_permissions_topic", "wecode_eval_permissions", ["topic_id"]
        )
        op.create_index(
            "idx_wecode_eval_permissions_user", "wecode_eval_permissions", ["user_id"]
        )
        op.create_index(
            "idx_wecode_eval_permissions_topic_user",
            "wecode_eval_permissions",
            ["topic_id", "user_id"],
        )

    # Create wecode_eval_answers table
    if not table_exists("wecode_eval_answers"):
        op.create_table(
            "wecode_eval_answers",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column(
                "question_id", sa.Integer(), nullable=False, comment="Related question ID"
            ),
            sa.Column(
                "question_version",
                sa.String(25),
                nullable=False,
                comment="Question version at submission time",
            ),
            sa.Column(
                "respondent_id",
                sa.Integer(),
                nullable=False,
                comment="Respondent user ID",
            ),
            sa.Column(
                "content_type",
                sa.String(20),
                nullable=False,
                server_default="text",
                comment="Content type",
            ),
            sa.Column(
                "content_data", sa.JSON(), nullable=False, comment="Answer content data"
            ),
            sa.Column(
                "submitted_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                comment="Submission time",
            ),
            sa.Column(
                "is_latest",
                sa.Boolean(),
                nullable=False,
                server_default="1",
                comment="Is latest submission",
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index(
            "idx_wecode_eval_answers_question", "wecode_eval_answers", ["question_id"]
        )
        op.create_index(
            "idx_wecode_eval_answers_respondent",
            "wecode_eval_answers",
            ["respondent_id"],
        )
        op.create_index(
            "idx_wecode_eval_answers_question_respondent",
            "wecode_eval_answers",
            ["question_id", "respondent_id"],
        )
        op.create_index(
            "idx_wecode_eval_answers_latest",
            "wecode_eval_answers",
            ["question_id", "respondent_id", "is_latest"],
        )

    # Create wecode_eval_grading_tasks table
    if not table_exists("wecode_eval_grading_tasks"):
        op.create_table(
            "wecode_eval_grading_tasks",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column(
                "answer_id", sa.Integer(), nullable=False, comment="Related answer ID"
            ),
            sa.Column(
                "question_id", sa.Integer(), nullable=False, comment="Related question ID"
            ),
            sa.Column(
                "question_version",
                sa.String(25),
                nullable=False,
                comment="Question version for grading",
            ),
            sa.Column(
                "respondent_id",
                sa.Integer(),
                nullable=False,
                comment="Respondent user ID",
            ),
            sa.Column(
                "grader_id",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Grader user ID",
            ),
            sa.Column(
                "team_id",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Wegent Team ID for AI grading",
            ),
            sa.Column(
                "task_id",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Wegent Task ID",
            ),
            sa.Column(
                "status",
                sa.Integer(),
                nullable=False,
                server_default="0",
                comment="Status: 0=pending, 1=running, 2=completed, 3=failed, 4=published",
            ),
            sa.Column(
                "report_data", sa.JSON(), nullable=False, comment="Grading report data"
            ),
            sa.Column(
                "report_s3_path",
                sa.String(500),
                nullable=False,
                server_default="",
                comment="Report S3 storage path",
            ),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                comment="Creation time",
            ),
            sa.Column("started_at", sa.DateTime(), nullable=True, comment="Start time"),
            sa.Column(
                "completed_at", sa.DateTime(), nullable=True, comment="Completion time"
            ),
            sa.Column(
                "published_at", sa.DateTime(), nullable=True, comment="Publication time"
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index(
            "idx_wecode_eval_grading_tasks_answer",
            "wecode_eval_grading_tasks",
            ["answer_id"],
        )
        op.create_index(
            "idx_wecode_eval_grading_tasks_question",
            "wecode_eval_grading_tasks",
            ["question_id"],
        )
        op.create_index(
            "idx_wecode_eval_grading_tasks_respondent",
            "wecode_eval_grading_tasks",
            ["respondent_id"],
        )
        op.create_index(
            "idx_wecode_eval_grading_tasks_status",
            "wecode_eval_grading_tasks",
            ["status"],
        )
        op.create_index(
            "idx_wecode_eval_grading_tasks_task",
            "wecode_eval_grading_tasks",
            ["task_id"],
        )


def downgrade() -> None:
    """Drop evaluation module tables."""
    op.drop_table("wecode_eval_grading_tasks")
    op.drop_table("wecode_eval_answers")
    op.drop_table("wecode_eval_permissions")
    op.drop_table("wecode_eval_question_versions")
    op.drop_table("wecode_eval_questions")
    op.drop_table("wecode_eval_topic_versions")
    op.drop_table("wecode_eval_topics")
