"""
Extended RAGAS evaluator with LLM-based metrics.
"""
import json
from typing import Any, Dict, Optional

import structlog
from langchain_openai import ChatOpenAI

from app.core.config import settings

logger = structlog.get_logger(__name__)


# Prompt templates for LLM-based metrics
CONTEXT_UTILIZATION_PROMPT = """You are an expert evaluator assessing how well an AI answer utilizes the provided context.

## Question
{question}

## Context (Retrieved Information)
{context}

## AI Answer
{answer}

## Task
Evaluate how effectively the answer utilizes information from the provided context.

Consider:
1. How much of the relevant context information is incorporated into the answer?
2. Does the answer reference specific details from the context?
3. Are there relevant parts of the context that were ignored?

Score the context utilization on a scale of 0.0 to 1.0:
- 1.0: Excellent - All relevant context information is effectively utilized
- 0.8: Good - Most relevant context is used appropriately
- 0.6: Moderate - Some context is used but important parts are missed
- 0.4: Poor - Limited use of available context
- 0.2: Very Poor - Minimal context utilization despite relevant information available
- 0.0: None - Context is completely ignored

Respond with ONLY a JSON object in this exact format:
{{"score": <float between 0 and 1>, "reasoning": "<brief explanation>"}}
"""

COHERENCE_PROMPT = """You are an expert evaluator assessing the coherence and logical flow of an AI answer.

## Question
{question}

## AI Answer
{answer}

## Task
Evaluate the coherence of the answer, considering:

1. Logical Structure: Does the answer follow a logical progression?
2. Internal Consistency: Are there any contradictions within the answer?
3. Clarity: Is the answer clear and easy to understand?
4. Completeness: Does the answer address all parts of the question?
5. Language Quality: Is the language fluent and well-constructed?

Score the coherence on a scale of 0.0 to 1.0:
- 1.0: Excellent - Perfectly coherent, logical, and clear
- 0.8: Good - Minor issues but overall well-structured
- 0.6: Moderate - Some logical gaps or clarity issues
- 0.4: Poor - Significant coherence problems
- 0.2: Very Poor - Difficult to follow, many issues
- 0.0: Incoherent - Completely lacks logical structure

Respond with ONLY a JSON object in this exact format:
{{"score": <float between 0 and 1>, "reasoning": "<brief explanation>"}}
"""


class LLMMetricsEvaluator:
    """Evaluator for LLM-based RAGAS metrics (extended)."""

    def __init__(self):
        self._llm = None

    @property
    def llm(self) -> ChatOpenAI:
        """Get or create LLM instance."""
        if self._llm is None:
            self._llm = ChatOpenAI(
                model=settings.RAGAS_LLM_MODEL,
                api_key=settings.RAGAS_LLM_API_KEY,
                base_url=settings.RAGAS_LLM_BASE_URL,
                temperature=0,
            )
        return self._llm

    def _parse_llm_response(self, response_text: str) -> Dict[str, Any]:
        """Parse LLM response JSON."""
        try:
            # Clean up the response
            text = response_text.strip()
            if text.startswith("```json"):
                text = text[7:]
            if text.startswith("```"):
                text = text[3:]
            if text.endswith("```"):
                text = text[:-3]
            return json.loads(text.strip())
        except json.JSONDecodeError as e:
            logger.warning("Failed to parse LLM response as JSON", error=str(e))
            return {"score": None, "reasoning": "Failed to parse response"}

    async def evaluate_context_utilization(
        self,
        question: str,
        context: str,
        answer: str,
    ) -> Optional[float]:
        """
        Evaluate how well the answer utilizes the provided context.

        Args:
            question: The user's question
            context: The retrieved context
            answer: The AI's answer

        Returns:
            Score between 0 and 1 (higher means better utilization)
        """
        try:
            prompt = CONTEXT_UTILIZATION_PROMPT.format(
                question=question[:2000],
                context=context[:5000] if context else "N/A",
                answer=answer[:3000] if answer else "N/A",
            )

            response = await self.llm.ainvoke(prompt)
            result = self._parse_llm_response(response.content)

            score = result.get("score")
            if score is not None:
                return max(0.0, min(1.0, float(score)))
            return None

        except Exception as e:
            logger.exception("Failed to evaluate context_utilization", error=str(e))
            return None

    async def evaluate_coherence(
        self,
        question: str,
        answer: str,
    ) -> Optional[float]:
        """
        Evaluate the coherence and logical flow of the answer.

        Args:
            question: The user's question
            answer: The AI's answer

        Returns:
            Score between 0 and 1 (higher means more coherent)
        """
        try:
            prompt = COHERENCE_PROMPT.format(
                question=question[:2000],
                answer=answer[:3000] if answer else "N/A",
            )

            response = await self.llm.ainvoke(prompt)
            result = self._parse_llm_response(response.content)

            score = result.get("score")
            if score is not None:
                return max(0.0, min(1.0, float(score)))
            return None

        except Exception as e:
            logger.exception("Failed to evaluate coherence", error=str(e))
            return None

    async def evaluate_all(
        self,
        question: str,
        context: str,
        answer: str,
    ) -> Dict[str, Any]:
        """
        Evaluate all extended LLM-based metrics.

        Note: faithfulness and answer_relevancy are still evaluated by the
        original RAGAS evaluator for compatibility.

        Args:
            question: The user's question
            context: The retrieved context
            answer: The AI's answer

        Returns:
            Dictionary containing metric scores
        """
        import asyncio

        # Run evaluations concurrently
        results = await asyncio.gather(
            self.evaluate_context_utilization(question, context, answer),
            self.evaluate_coherence(question, answer),
            return_exceptions=True,
        )

        return {
            "context_utilization": results[0] if not isinstance(results[0], Exception) else None,
            "coherence": results[1] if not isinstance(results[1], Exception) else None,
        }


# Global evaluator instance
llm_metrics_evaluator = LLMMetricsEvaluator()
