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
        sa.Column(
            "artifact_id",
            sa.String(length=36),
            nullable=False,
            comment="Artifact UUID",
        ),
        sa.Column(
            "knowledge_base_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Owning knowledge base ID; 0 means unset",
        ),
        sa.Column(
            "artifact_type",
            sa.String(length=32),
            nullable=False,
            server_default="briefing",
            comment="Artifact type: briefing or mind_map",
        ),
        sa.Column(
            "title",
            sa.String(length=255),
            nullable=False,
            server_default="",
            comment="Artifact title",
        ),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default="queued",
            comment="Lifecycle status",
        ),
        sa.Column(
            "task_id",
            bigint_id,
            nullable=False,
            server_default="0",
            comment="Related task ID; 0 means unset",
        ),
        sa.Column(
            "assistant_subtask_id",
            bigint_id,
            nullable=False,
            server_default="0",
            comment="Related assistant subtask ID; 0 means unset",
        ),
        sa.Column(
            "content",
            sa.String(length=12000),
            nullable=False,
            server_default="",
            comment="Generated content; empty means unavailable",
        ),
        sa.Column(
            "source_document_ids",
            sa.JSON(),
            nullable=False,
            comment="Source document ID list",
        ),
        sa.Column(
            "generation_config",
            sa.JSON(),
            nullable=False,
            comment="Generation configuration",
        ),
        sa.Column(
            "error_code",
            sa.String(length=64),
            nullable=False,
            server_default="",
            comment="Failure code; empty means no error",
        ),
        sa.Column(
            "error_message",
            sa.String(length=2000),
            nullable=False,
            server_default="",
            comment="Failure message; empty means no error",
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Creator user ID; 0 means unset",
        ),
        sa.Column(
            "schema_version",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="Content schema version",
        ),
        sa.Column(
            "version",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="Record version",
        ),
        sa.Column(
            "attempt",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="Generation attempt number",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            comment="Last update time",
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(),
            nullable=False,
            server_default="1970-01-01 00:00:00",
            comment="Completion time; Unix epoch means incomplete",
        ),
        sa.PrimaryKeyConstraint("artifact_id"),
        comment="Knowledge base generated artifacts",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_knowledge_artifacts_kb_created",
        "knowledge_artifacts",
        ["knowledge_base_id", "created_at", "artifact_id"],
    )


def downgrade() -> None:
    op.drop_table("knowledge_artifacts")
