"""Add evaluation_judgment field for three-state evaluation

Revision ID: 005
Revises: 004
Create Date: 2026-01-14
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Default threshold for core metrics
EVALUATION_CORE_THRESHOLD = 0.6


def upgrade() -> None:
    # Add evaluation_judgment column to evaluation_results table
    op.add_column(
        "evaluation_results",
        sa.Column(
            "evaluation_judgment",
            sa.String(20),
            nullable=True,
            comment="Three-state evaluation judgment: pass/fail/undetermined",
        ),
    )

    # Create index for evaluation_judgment
    op.create_index(
        "idx_evaluation_judgment",
        "evaluation_results",
        ["evaluation_judgment"],
    )

    # Backfill evaluation_judgment for existing records
    # Three-state logic:
    # - undetermined: any core metric is NULL
    # - fail: all metrics have values but any < threshold (0.6)
    # - pass: all metrics >= threshold (0.6)
    #
    # Core metrics:
    # - faithfulness_score (RAGAS)
    # - trulens_groundedness (TruLens)
    # - ragas_query_context_relevance (RAGAS)
    # - trulens_context_relevance (TruLens)

    threshold = EVALUATION_CORE_THRESHOLD

    # Step 1: Set 'undetermined' for records with any NULL core metric
    op.execute(
        f"""
        UPDATE evaluation_results
        SET evaluation_judgment = 'undetermined',
            is_failed = 0,
            failure_reason = 'Core metrics incomplete'
        WHERE faithfulness_score IS NULL
           OR trulens_groundedness IS NULL
           OR ragas_query_context_relevance IS NULL
           OR trulens_context_relevance IS NULL
        """
    )

    # Step 2: Set 'fail' for records with all metrics present but any < threshold
    op.execute(
        f"""
        UPDATE evaluation_results
        SET evaluation_judgment = 'fail',
            is_failed = 1,
            failure_reason = CONCAT_WS('; ',
                CASE WHEN faithfulness_score < {threshold} THEN CONCAT('faithfulness (', ROUND(faithfulness_score, 2), ') < {threshold}') END,
                CASE WHEN trulens_groundedness < {threshold} THEN CONCAT('groundedness (', ROUND(trulens_groundedness, 2), ') < {threshold}') END,
                CASE WHEN ragas_query_context_relevance < {threshold} THEN CONCAT('query_context_relevance (', ROUND(ragas_query_context_relevance, 2), ') < {threshold}') END,
                CASE WHEN trulens_context_relevance < {threshold} THEN CONCAT('context_relevance (', ROUND(trulens_context_relevance, 2), ') < {threshold}') END
            )
        WHERE evaluation_judgment IS NULL
          AND faithfulness_score IS NOT NULL
          AND trulens_groundedness IS NOT NULL
          AND ragas_query_context_relevance IS NOT NULL
          AND trulens_context_relevance IS NOT NULL
          AND (faithfulness_score < {threshold}
               OR trulens_groundedness < {threshold}
               OR ragas_query_context_relevance < {threshold}
               OR trulens_context_relevance < {threshold})
        """
    )

    # Step 3: Set 'pass' for records with all metrics >= threshold
    op.execute(
        f"""
        UPDATE evaluation_results
        SET evaluation_judgment = 'pass',
            is_failed = 0,
            failure_reason = NULL
        WHERE evaluation_judgment IS NULL
          AND faithfulness_score IS NOT NULL
          AND trulens_groundedness IS NOT NULL
          AND ragas_query_context_relevance IS NOT NULL
          AND trulens_context_relevance IS NOT NULL
          AND faithfulness_score >= {threshold}
          AND trulens_groundedness >= {threshold}
          AND ragas_query_context_relevance >= {threshold}
          AND trulens_context_relevance >= {threshold}
        """
    )


def downgrade() -> None:
    # Drop index
    op.drop_index("idx_evaluation_judgment", table_name="evaluation_results")

    # Drop column
    op.drop_column("evaluation_results", "evaluation_judgment")
