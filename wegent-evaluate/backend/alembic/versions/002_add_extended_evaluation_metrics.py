"""Add extended evaluation metrics for RAGAS and TruLens

Revision ID: 002
Revises: 001
Create Date: 2026-01-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add RAGAS Embedding-based metrics
    op.add_column(
        "evaluation_results",
        sa.Column("ragas_query_context_relevance", sa.Float(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("ragas_context_precision_emb", sa.Float(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("ragas_context_diversity", sa.Float(), nullable=True),
    )

    # Add RAGAS LLM-based metrics (some already exist: faithfulness_score, answer_relevancy_score, context_precision_score)
    op.add_column(
        "evaluation_results",
        sa.Column("ragas_context_utilization", sa.Float(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("ragas_coherence", sa.Float(), nullable=True),
    )

    # Add TruLens Embedding-based metrics
    op.add_column(
        "evaluation_results",
        sa.Column("trulens_context_relevance", sa.Float(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("trulens_relevance_embedding", sa.Float(), nullable=True),
    )

    # Add TruLens LLM-based metrics
    op.add_column(
        "evaluation_results",
        sa.Column("trulens_groundedness", sa.Float(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("trulens_relevance_llm", sa.Float(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("trulens_coherence", sa.Float(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("trulens_harmlessness", sa.Float(), nullable=True),
    )

    # Add cross-validation results
    op.add_column(
        "evaluation_results",
        sa.Column("cross_validation_results", sa.JSON(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("has_cross_validation_alert", sa.Boolean(), default=False, nullable=True),
    )

    # Add LLM diagnostic analysis results
    op.add_column(
        "evaluation_results",
        sa.Column("ragas_analysis", sa.JSON(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("trulens_analysis", sa.JSON(), nullable=True),
    )
    op.add_column(
        "evaluation_results",
        sa.Column("overall_analysis", sa.JSON(), nullable=True),
    )

    # Create index for cross-validation alerts
    op.create_index(
        "idx_er_has_cv_alert",
        "evaluation_results",
        ["has_cross_validation_alert"],
    )

    # Create evaluation_alerts table
    op.create_table(
        "evaluation_alerts",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("evaluation_id", sa.BigInteger(), nullable=False),
        sa.Column("pair_name", sa.String(100), nullable=False),
        sa.Column("eval_target", sa.String(50), nullable=True),
        sa.Column("signal_source", sa.String(50), nullable=True),
        sa.Column("scoring_goal", sa.String(50), nullable=True),
        sa.Column("ragas_metric", sa.String(100), nullable=True),
        sa.Column("trulens_metric", sa.String(100), nullable=True),
        sa.Column("ragas_score", sa.Float(), nullable=True),
        sa.Column("trulens_score", sa.Float(), nullable=True),
        sa.Column("difference", sa.Float(), nullable=True),
        sa.Column("threshold", sa.Float(), default=0.2, nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["evaluation_id"],
            ["evaluation_results.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_ea_evaluation_id", "evaluation_alerts", ["evaluation_id"])
    op.create_index("idx_ea_pair_name", "evaluation_alerts", ["pair_name"])
    op.create_index("idx_ea_created_at", "evaluation_alerts", ["created_at"])


def downgrade() -> None:
    # Drop evaluation_alerts table
    op.drop_index("idx_ea_created_at", table_name="evaluation_alerts")
    op.drop_index("idx_ea_pair_name", table_name="evaluation_alerts")
    op.drop_index("idx_ea_evaluation_id", table_name="evaluation_alerts")
    op.drop_table("evaluation_alerts")

    # Drop cross-validation alert index
    op.drop_index("idx_er_has_cv_alert", table_name="evaluation_results")

    # Drop LLM diagnostic analysis columns
    op.drop_column("evaluation_results", "overall_analysis")
    op.drop_column("evaluation_results", "trulens_analysis")
    op.drop_column("evaluation_results", "ragas_analysis")

    # Drop cross-validation columns
    op.drop_column("evaluation_results", "has_cross_validation_alert")
    op.drop_column("evaluation_results", "cross_validation_results")

    # Drop TruLens LLM-based metrics
    op.drop_column("evaluation_results", "trulens_harmlessness")
    op.drop_column("evaluation_results", "trulens_coherence")
    op.drop_column("evaluation_results", "trulens_relevance_llm")
    op.drop_column("evaluation_results", "trulens_groundedness")

    # Drop TruLens Embedding-based metrics
    op.drop_column("evaluation_results", "trulens_relevance_embedding")
    op.drop_column("evaluation_results", "trulens_context_relevance")

    # Drop RAGAS LLM-based metrics
    op.drop_column("evaluation_results", "ragas_coherence")
    op.drop_column("evaluation_results", "ragas_context_utilization")

    # Drop RAGAS Embedding-based metrics
    op.drop_column("evaluation_results", "ragas_context_diversity")
    op.drop_column("evaluation_results", "ragas_context_precision_emb")
    op.drop_column("evaluation_results", "ragas_query_context_relevance")
