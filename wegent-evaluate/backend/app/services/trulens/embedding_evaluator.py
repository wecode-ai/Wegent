"""
TruLens evaluator with Embedding-based metrics.
"""
import asyncio
from typing import Any, Dict, List, Optional

import numpy as np
import structlog
from langchain_openai import OpenAIEmbeddings

from app.core.config import settings

logger = structlog.get_logger(__name__)

# Retry configuration
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 1.0


class TruLensEmbeddingEvaluator:
    """Evaluator for TruLens Embedding-based metrics."""

    def __init__(self):
        self._embeddings = None

    @property
    def embeddings(self) -> OpenAIEmbeddings:
        """Get or create embeddings instance."""
        if self._embeddings is None:
            self._embeddings = OpenAIEmbeddings(
                model=settings.RAGAS_EMBEDDING_MODEL,
                api_key=settings.RAGAS_EMBEDDING_API_KEY,
                base_url=settings.RAGAS_EMBEDDING_BASE_URL,
            )
        return self._embeddings

    def _cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        vec1 = np.array(vec1)
        vec2 = np.array(vec2)
        dot_product = np.dot(vec1, vec2)
        norm1 = np.linalg.norm(vec1)
        norm2 = np.linalg.norm(vec2)
        if norm1 == 0 or norm2 == 0:
            return 0.0
        return float(dot_product / (norm1 * norm2))

    async def _get_embedding(self, text: str) -> List[float]:
        """Get embedding for a text string with retry logic."""
        max_chars = 8000
        if len(text) > max_chars:
            text = text[:max_chars]

        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                embedding = await asyncio.to_thread(
                    self.embeddings.embed_query, text
                )
                return embedding
            except Exception as e:
                last_error = e
                logger.warning(
                    "TruLens embedding API call failed, retrying",
                    attempt=attempt + 1,
                    max_retries=MAX_RETRIES,
                    error_type=type(e).__name__,
                    error=str(e),
                    text_length=len(text),
                    model=settings.RAGAS_EMBEDDING_MODEL,
                    base_url=settings.RAGAS_EMBEDDING_BASE_URL,
                )
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAY_SECONDS * (attempt + 1))

        # Log final failure with full details
        logger.error(
            "TruLens embedding API call failed after all retries",
            error_type=type(last_error).__name__,
            error=str(last_error),
            text_length=len(text),
            model=settings.RAGAS_EMBEDDING_MODEL,
            base_url=settings.RAGAS_EMBEDDING_BASE_URL,
            api_key_set=bool(settings.RAGAS_EMBEDDING_API_KEY and settings.RAGAS_EMBEDDING_API_KEY != "your_openai_api_key"),
        )
        raise last_error

    async def evaluate_context_relevance(
        self,
        query: str,
        contexts: List[str],
    ) -> Optional[float]:
        """
        Evaluate context relevance using embedding similarity.

        This TruLens metric measures how semantically relevant the retrieved
        contexts are to the user's query.

        Args:
            query: The user's question
            contexts: List of retrieved context chunks

        Returns:
            Score between 0 and 1 (higher is better), or None if evaluation fails
        """
        if not contexts:
            return 0.0

        try:
            # Get query embedding
            query_embedding = await self._get_embedding(query)

            # Combine all contexts into one for overall relevance
            combined_context = " ".join(contexts)[:8000]
            context_embedding = await self._get_embedding(combined_context)

            # Calculate similarity
            similarity = self._cosine_similarity(query_embedding, context_embedding)

            # Normalize to 0-1 range
            normalized_score = (similarity + 1) / 2

            return max(0.0, min(1.0, normalized_score))

        except Exception as e:
            logger.error(
                "Failed to evaluate TruLens context_relevance",
                error_type=type(e).__name__,
                error=str(e),
                query_length=len(query),
                contexts_count=len(contexts),
            )
            return None

    async def evaluate_relevance(
        self,
        query: str,
        answer: str,
    ) -> Optional[float]:
        """
        Evaluate answer relevance using embedding similarity.

        This TruLens metric measures how semantically relevant the answer
        is to the user's query (embedding-based version).

        Args:
            query: The user's question
            answer: The AI's answer

        Returns:
            Score between 0 and 1 (higher is better), or None if evaluation fails
        """
        if not answer:
            return 0.0

        try:
            # Get embeddings
            query_embedding = await self._get_embedding(query)
            answer_embedding = await self._get_embedding(answer)

            # Calculate similarity
            similarity = self._cosine_similarity(query_embedding, answer_embedding)

            # Normalize to 0-1 range
            normalized_score = (similarity + 1) / 2

            return max(0.0, min(1.0, normalized_score))

        except Exception as e:
            logger.error(
                "Failed to evaluate TruLens relevance (embedding)",
                error_type=type(e).__name__,
                error=str(e),
                query_length=len(query),
                answer_length=len(answer),
            )
            return None

    async def evaluate_all(
        self,
        query: str,
        contexts: List[str],
        answer: str,
    ) -> Dict[str, Any]:
        """
        Evaluate all TruLens embedding-based metrics.

        Args:
            query: The user's question
            contexts: List of retrieved context chunks
            answer: The AI's answer

        Returns:
            Dictionary containing all metric scores
        """
        # Log start of evaluation with configuration info
        logger.info(
            "Starting TruLens embedding metrics evaluation",
            query_length=len(query),
            contexts_count=len(contexts),
            answer_length=len(answer) if answer else 0,
            embedding_model=settings.RAGAS_EMBEDDING_MODEL,
            embedding_base_url=settings.RAGAS_EMBEDDING_BASE_URL,
            api_key_configured=bool(settings.RAGAS_EMBEDDING_API_KEY and settings.RAGAS_EMBEDDING_API_KEY != "your_openai_api_key"),
        )

        results = await asyncio.gather(
            self.evaluate_context_relevance(query, contexts),
            self.evaluate_relevance(query, answer),
            return_exceptions=True,
        )

        # Process results and log any exceptions
        processed_results = {}
        metric_names = ["context_relevance", "relevance_embedding"]

        for name, result in zip(metric_names, results):
            if isinstance(result, Exception):
                logger.error(
                    f"TruLens embedding metric {name} raised exception",
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
                "TruLens embedding evaluation completed with null metrics",
                null_metrics=null_metrics,
                successful_metrics=[name for name, val in processed_results.items() if val is not None],
            )
        else:
            logger.info(
                "TruLens embedding evaluation completed successfully",
                results=processed_results,
            )

        return processed_results


# Global evaluator instance
trulens_embedding_evaluator = TruLensEmbeddingEvaluator()
