"""
Extended RAGAS evaluator with LLM-based metrics.
"""
import asyncio
import json
from typing import Any, Dict, Optional

import structlog
from langchain_openai import ChatOpenAI

from app.core.config import settings

logger = structlog.get_logger(__name__)

# Retry configuration
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 1.0


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

    async def _invoke_llm_with_retry(self, prompt: str) -> str:
        """Invoke LLM with retry logic."""
        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                response = await self.llm.ainvoke(prompt)
                return response.content
            except Exception as e:
                last_error = e
                logger.warning(
                    "RAGAS LLM API call failed, retrying",
                    attempt=attempt + 1,
                    max_retries=MAX_RETRIES,
                    error_type=type(e).__name__,
                    error=str(e),
                    model=settings.RAGAS_LLM_MODEL,
                    base_url=settings.RAGAS_LLM_BASE_URL,
                )
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAY_SECONDS * (attempt + 1))

        # Log final failure with full details
        logger.error(
            "RAGAS LLM API call failed after all retries",
            error_type=type(last_error).__name__,
            error=str(last_error),
            model=settings.RAGAS_LLM_MODEL,
            base_url=settings.RAGAS_LLM_BASE_URL,
            api_key_set=bool(settings.RAGAS_LLM_API_KEY and settings.RAGAS_LLM_API_KEY != "your_openai_api_key"),
        )
        raise last_error

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
            Score between 0 and 1 (higher means better utilization), or None if evaluation fails
        """
        try:
            prompt = CONTEXT_UTILIZATION_PROMPT.format(
                question=question[:2000],
                context=context[:5000] if context else "N/A",
                answer=answer[:3000] if answer else "N/A",
            )

            response_content = await self._invoke_llm_with_retry(prompt)
            result = self._parse_llm_response(response_content)

            score = result.get("score")
            if score is not None:
                return max(0.0, min(1.0, float(score)))
            return None

        except Exception as e:
            logger.error(
                "Failed to evaluate context_utilization",
                error_type=type(e).__name__,
                error=str(e),
                question_length=len(question),
                context_length=len(context) if context else 0,
                answer_length=len(answer) if answer else 0,
            )
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
            Score between 0 and 1 (higher means more coherent), or None if evaluation fails
        """
        try:
            prompt = COHERENCE_PROMPT.format(
                question=question[:2000],
                answer=answer[:3000] if answer else "N/A",
            )

            response_content = await self._invoke_llm_with_retry(prompt)
            result = self._parse_llm_response(response_content)

            score = result.get("score")
            if score is not None:
                return max(0.0, min(1.0, float(score)))
            return None

        except Exception as e:
            logger.error(
                "Failed to evaluate coherence",
                error_type=type(e).__name__,
                error=str(e),
                question_length=len(question),
                answer_length=len(answer) if answer else 0,
            )
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
        # Log start of evaluation with configuration info
        logger.info(
            "Starting RAGAS LLM metrics evaluation",
            question_length=len(question),
            context_length=len(context) if context else 0,
            answer_length=len(answer) if answer else 0,
            llm_model=settings.RAGAS_LLM_MODEL,
            llm_base_url=settings.RAGAS_LLM_BASE_URL,
            api_key_configured=bool(settings.RAGAS_LLM_API_KEY and settings.RAGAS_LLM_API_KEY != "your_openai_api_key"),
        )

        # Run evaluations concurrently
        results = await asyncio.gather(
            self.evaluate_context_utilization(question, context, answer),
            self.evaluate_coherence(question, answer),
            return_exceptions=True,
        )

        # Process results and log any exceptions
        processed_results = {}
        metric_names = ["context_utilization", "coherence"]

        for name, result in zip(metric_names, results):
            if isinstance(result, Exception):
                logger.error(
                    f"RAGAS LLM metric {name} raised exception",
                    metric=name,
                    error_type=type(result).__name__,
                    error=str(result),
                )
                processed_results[name] = None
            else:
                processed_results[name] = result

        # Log summary of results
        null_metrics = [name for name, val in processed_results.items() if val is None]
        if null_metrics:
            logger.warning(
                "RAGAS LLM evaluation completed with null metrics",
                null_metrics=null_metrics,
                successful_metrics=[name for name, val in processed_results.items() if val is not None],
            )
        else:
            logger.info(
                "RAGAS LLM evaluation completed successfully",
                results=processed_results,
            )

        return processed_results


# Global evaluator instance
llm_metrics_evaluator = LLMMetricsEvaluator()
