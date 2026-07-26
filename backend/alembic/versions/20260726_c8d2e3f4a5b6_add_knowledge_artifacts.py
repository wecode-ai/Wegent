"""Add durable knowledge Artifact storage.

Revision ID: c8d2e3f4a5b6
Revises: b7c1d2e3f4a5
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c8d2e3f4a5b6"
down_revision: str | None = "b7c1d2e3f4a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bigint_id = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
    op.create_table(
        "knowledge_artifacts",
        sa.Column("artifact_id", sa.String(length=36), nullable=False),
        sa.Column("knowledge_base_id", sa.Integer(), nullable=False),
        sa.Column("artifact_type", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("task_id", bigint_id, nullable=True),
        sa.Column("assistant_subtask_id", bigint_id, nullable=True),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("source_document_ids", sa.JSON(), nullable=False),
        sa.Column("generation_config", sa.JSON(), nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "schema_version",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
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
        ),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("artifact_id"),
    )
    op.create_index(
        "ix_knowledge_artifacts_kb_created",
        "knowledge_artifacts",
        ["knowledge_base_id", "created_at", "artifact_id"],
    )
    op.create_index(
        "ix_knowledge_artifacts_status_updated",
        "knowledge_artifacts",
        ["status", "updated_at"],
    )
    op.create_index(
        "ix_knowledge_artifacts_user_id",
        "knowledge_artifacts",
        ["user_id"],
    )
    op.create_index(
        "ix_knowledge_artifacts_task_id",
        "knowledge_artifacts",
        ["task_id"],
    )
    op.create_index(
        "ix_knowledge_artifacts_assistant_subtask_id",
        "knowledge_artifacts",
        ["assistant_subtask_id"],
    )


def downgrade() -> None:
    op.drop_table("knowledge_artifacts")
