"""
Cross-validation service for comparing RAGAS and TruLens metrics.
"""
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger(__name__)


# Cross-validation pairs configuration
# Only pairs that match on three dimensions: evaluation target, signal source, and scoring goal
CROSS_VALIDATION_PAIRS = [
    {
        "name": "retrieval_relevance",
        "ragas_metric": "ragas_query_context_relevance",
        "trulens_metric": "trulens_context_relevance",
        "eval_target": "retrieval",
        "signal_source": "embedding",
        "scoring_goal": "relevance",
        "description": "Compares retrieval relevance evaluation between RAGAS and TruLens",
    },
    {
        "name": "answer_relevance",
        "ragas_metric": "answer_relevancy_score",  # Original RAGAS metric
        "trulens_metric": "trulens_relevance_llm",
        "eval_target": "generation",
        "signal_source": "llm",
        "scoring_goal": "relevance",
        "description": "Compares answer relevance evaluation between RAGAS and TruLens",
    },
    {
        "name": "factual_grounding",
        "ragas_metric": "faithfulness_score",  # Original RAGAS metric
        "trulens_metric": "trulens_groundedness",
        "eval_target": "grounding",
        "signal_source": "llm",
        "scoring_goal": "factuality",
        "description": "Compares factual grounding evaluation between RAGAS and TruLens",
    },
]

# Default alert threshold (20% difference)
DEFAULT_ALERT_THRESHOLD = 0.2


class CrossValidationService:
    """Service for cross-validating RAGAS and TruLens metrics."""

    def __init__(self, threshold: float = DEFAULT_ALERT_THRESHOLD):
        """
        Initialize the cross-validation service.

        Args:
            threshold: Alert threshold for score differences (default 0.2 = 20%)
        """
        self.threshold = threshold

    def validate(
        self,
        ragas_metrics: Dict[str, Optional[float]],
        trulens_metrics: Dict[str, Optional[float]],
    ) -> Dict[str, Any]:
        """
        Perform cross-validation between RAGAS and TruLens metrics.

        Args:
            ragas_metrics: Dictionary of RAGAS metric scores
            trulens_metrics: Dictionary of TruLens metric scores

        Returns:
            Dictionary containing:
            - pairs: List of validation results for each pair
            - has_alert: Whether any pair exceeded the threshold
            - alert_count: Number of pairs with alerts
        """
        results = []
        has_alert = False
        alert_count = 0

        for pair in CROSS_VALIDATION_PAIRS:
            ragas_score = ragas_metrics.get(pair["ragas_metric"])
            trulens_score = trulens_metrics.get(pair["trulens_metric"])

            pair_result = {
                "name": pair["name"],
                "ragas_metric": pair["ragas_metric"],
                "trulens_metric": pair["trulens_metric"],
                "eval_target": pair["eval_target"],
                "signal_source": pair["signal_source"],
                "scoring_goal": pair["scoring_goal"],
                "ragas_score": ragas_score,
                "trulens_score": trulens_score,
                "difference": None,
                "is_alert": False,
                "threshold": self.threshold,
            }

            # Calculate difference if both scores are available
            if ragas_score is not None and trulens_score is not None:
                difference = abs(ragas_score - trulens_score)
                pair_result["difference"] = round(difference, 4)

                # Check if difference exceeds threshold
                if difference > self.threshold:
                    pair_result["is_alert"] = True
                    has_alert = True
                    alert_count += 1

            results.append(pair_result)

        return {
            "pairs": results,
            "has_alert": has_alert,
            "alert_count": alert_count,
            "threshold": self.threshold,
        }

    def get_alerts(
        self,
        ragas_metrics: Dict[str, Optional[float]],
        trulens_metrics: Dict[str, Optional[float]],
    ) -> List[Dict[str, Any]]:
        """
        Get list of cross-validation alerts (pairs that exceed threshold).

        Args:
            ragas_metrics: Dictionary of RAGAS metric scores
            trulens_metrics: Dictionary of TruLens metric scores

        Returns:
            List of alert dictionaries
        """
        validation_result = self.validate(ragas_metrics, trulens_metrics)
        return [pair for pair in validation_result["pairs"] if pair["is_alert"]]

    @staticmethod
    def get_pair_config() -> List[Dict[str, Any]]:
        """Get the cross-validation pair configuration."""
        return CROSS_VALIDATION_PAIRS.copy()


# Global service instance
cross_validation_service = CrossValidationService()
