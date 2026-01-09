"""Initial migration

Revision ID: 001
Revises:
Create Date: 2026-01-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create conversation_records table
    op.create_table(
        "conversation_records",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("task_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("subtask_id", sa.BigInteger(), nullable=False),
        sa.Column("subtask_context_id", sa.BigInteger(), nullable=False),
        sa.Column("user_prompt", sa.Text(), nullable=False),
        sa.Column("assistant_answer", sa.Text(), nullable=False),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column("knowledge_base_result", sa.JSON(), nullable=True),
        sa.Column("knowledge_base_config", sa.JSON(), nullable=True),
        sa.Column("knowledge_id", sa.Integer(), nullable=True),
        sa.Column("knowledge_name", sa.String(255), nullable=True),
        sa.Column("retriever_name", sa.String(255), nullable=True),
        sa.Column("embedding_model", sa.String(255), nullable=True),
        sa.Column("retrieval_mode", sa.String(50), nullable=True),
        sa.Column("original_created_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column(
            "evaluation_status",
            sa.Enum("pending", "skipped", "processing", "completed", "failed", name="evaluationstatus"),
            nullable=False,
        ),
        sa.Column("skip_reason", sa.String(255), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("subtask_context_id"),
    )
    op.create_index("idx_task_id", "conversation_records", ["task_id"])
    op.create_index("idx_user_id", "conversation_records", ["user_id"])
    op.create_index("idx_subtask_id", "conversation_records", ["subtask_id"])
    op.create_index("idx_evaluation_status", "conversation_records", ["evaluation_status"])
    op.create_index("idx_original_created_at", "conversation_records", ["original_created_at"])
    op.create_index("idx_retriever_name", "conversation_records", ["retriever_name"])
    op.create_index("idx_embedding_model", "conversation_records", ["embedding_model"])
    op.create_index("idx_knowledge_id", "conversation_records", ["knowledge_id"])

    # Create evaluation_results table
    op.create_table(
        "evaluation_results",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("conversation_record_id", sa.BigInteger(), nullable=False),
        sa.Column("faithfulness_score", sa.Float(), nullable=True),
        sa.Column("answer_relevancy_score", sa.Float(), nullable=True),
        sa.Column("context_precision_score", sa.Float(), nullable=True),
        sa.Column("overall_score", sa.Float(), nullable=True),
        sa.Column("ragas_raw_result", sa.JSON(), nullable=True),
        sa.Column("llm_analysis", sa.JSON(), nullable=True),
        sa.Column("llm_suggestions", sa.Text(), nullable=True),
        sa.Column("has_issue", sa.Boolean(), nullable=False, default=False),
        sa.Column("issue_types", sa.JSON(), nullable=True),
        sa.Column("evaluation_model", sa.String(100), nullable=True),
        sa.Column("evaluation_duration_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["conversation_record_id"],
            ["conversation_records.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("conversation_record_id"),
    )
    op.create_index("idx_er_conversation_record_id", "evaluation_results", ["conversation_record_id"])
    op.create_index("idx_er_created_at", "evaluation_results", ["created_at"])
    op.create_index("idx_er_has_issue", "evaluation_results", ["has_issue"])
    op.create_index("idx_er_overall_score", "evaluation_results", ["overall_score"])

    # Create sync_jobs table
    op.create_table(
        "sync_jobs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("sync_id", sa.String(36), nullable=False),
        sa.Column("start_time", sa.DateTime(), nullable=False),
        sa.Column("end_time", sa.DateTime(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("started", "running", "completed", "failed", name="syncstatus"),
            nullable=False,
        ),
        sa.Column("total_fetched", sa.Integer(), nullable=False, default=0),
        sa.Column("total_inserted", sa.Integer(), nullable=False, default=0),
        sa.Column("total_skipped", sa.Integer(), nullable=False, default=0),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sync_id"),
    )
    op.create_index("idx_sj_sync_id", "sync_jobs", ["sync_id"])
    op.create_index("idx_sj_status", "sync_jobs", ["status"])
    op.create_index("idx_sj_created_at", "sync_jobs", ["created_at"])


def downgrade() -> None:
    op.drop_table("sync_jobs")
    op.drop_table("evaluation_results")
    op.drop_table("conversation_records")
    op.execute("DROP TYPE IF EXISTS evaluationstatus")
    op.execute("DROP TYPE IF EXISTS syncstatus")
