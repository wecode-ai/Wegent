"""
Extended RAGAS evaluator with Embedding-based metrics.
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


class EmbeddingMetricsEvaluator:
    """Evaluator for Embedding-based RAGAS metrics."""

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
        # Truncate text if too long (most embedding models have token limits)
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
                    "Embedding API call failed, retrying",
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
            "Embedding API call failed after all retries",
            error_type=type(last_error).__name__,
            error=str(last_error),
            text_length=len(text),
            model=settings.RAGAS_EMBEDDING_MODEL,
            base_url=settings.RAGAS_EMBEDDING_BASE_URL,
            api_key_set=bool(settings.RAGAS_EMBEDDING_API_KEY and settings.RAGAS_EMBEDDING_API_KEY != "your_openai_api_key"),
        )
        raise last_error

    async def _get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        """Get embeddings for multiple texts with retry logic."""
        # Truncate texts if too long
        max_chars = 8000
        truncated_texts = [t[:max_chars] if len(t) > max_chars else t for t in texts]

        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                embeddings = await asyncio.to_thread(
                    self.embeddings.embed_documents, truncated_texts
                )
                return embeddings
            except Exception as e:
                last_error = e
                logger.warning(
                    "Batch embedding API call failed, retrying",
                    attempt=attempt + 1,
                    max_retries=MAX_RETRIES,
                    error_type=type(e).__name__,
                    error=str(e),
                    batch_size=len(truncated_texts),
                    model=settings.RAGAS_EMBEDDING_MODEL,
                    base_url=settings.RAGAS_EMBEDDING_BASE_URL,
                )
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAY_SECONDS * (attempt + 1))

        # Log final failure with full details
        logger.error(
            "Batch embedding API call failed after all retries",
            error_type=type(last_error).__name__,
            error=str(last_error),
            batch_size=len(truncated_texts),
            model=settings.RAGAS_EMBEDDING_MODEL,
            base_url=settings.RAGAS_EMBEDDING_BASE_URL,
            api_key_set=bool(settings.RAGAS_EMBEDDING_API_KEY and settings.RAGAS_EMBEDDING_API_KEY != "your_openai_api_key"),
        )
        raise last_error

    async def evaluate_query_context_relevance(
        self,
        query: str,
        contexts: List[str],
    ) -> Optional[float]:
        """
        Evaluate query-context relevance using embedding similarity.

        This metric measures how semantically relevant the retrieved contexts
        are to the user's query.

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

            # Get context embeddings
            context_embeddings = await self._get_embeddings_batch(contexts)

            # Calculate similarity for each context
            similarities = [
                self._cosine_similarity(query_embedding, ctx_emb)
                for ctx_emb in context_embeddings
            ]

            # Return average similarity
            avg_similarity = sum(similarities) / len(similarities)

            # Normalize to 0-1 range (cosine similarity can be negative)
            normalized_score = (avg_similarity + 1) / 2

            return max(0.0, min(1.0, normalized_score))

        except Exception as e:
            logger.error(
                "Failed to evaluate query_context_relevance",
                error_type=type(e).__name__,
                error=str(e),
                query_length=len(query),
                contexts_count=len(contexts),
            )
            return None

    async def evaluate_context_precision(
        self,
        query: str,
        contexts: List[str],
        relevance_threshold: float = 0.5,
    ) -> Optional[float]:
        """
        Evaluate context precision using embedding similarity.

        This metric measures the ratio of relevant context chunks to total chunks.
        A chunk is considered relevant if its similarity to the query exceeds
        the threshold.

        Args:
            query: The user's question
            contexts: List of retrieved context chunks
            relevance_threshold: Similarity threshold for relevance (default 0.5)

        Returns:
            Score between 0 and 1 (higher is better), or None if evaluation fails
        """
        if not contexts:
            return 0.0

        try:
            # Get query embedding
            query_embedding = await self._get_embedding(query)

            # Get context embeddings
            context_embeddings = await self._get_embeddings_batch(contexts)

            # Count relevant contexts
            relevant_count = 0
            for ctx_emb in context_embeddings:
                similarity = self._cosine_similarity(query_embedding, ctx_emb)
                # Normalize similarity to 0-1 range
                normalized_sim = (similarity + 1) / 2
                if normalized_sim >= relevance_threshold:
                    relevant_count += 1

            # Calculate precision
            precision = relevant_count / len(contexts)

            return max(0.0, min(1.0, precision))

        except Exception as e:
            logger.error(
                "Failed to evaluate context_precision",
                error_type=type(e).__name__,
                error=str(e),
                query_length=len(query),
                contexts_count=len(contexts),
            )
            return None

    async def evaluate_context_diversity(
        self,
        contexts: List[str],
    ) -> Optional[float]:
        """
        Evaluate context diversity using pairwise embedding similarity.

        This metric measures how diverse the retrieved contexts are.
        High diversity means the contexts cover different aspects of the topic.

        Formula: diversity = 1 - average_pairwise_similarity

        Args:
            contexts: List of retrieved context chunks

        Returns:
            Score between 0 and 1 (higher means more diverse), or None if evaluation fails
        """
        if len(contexts) < 2:
            # Single context or no context - consider it as diverse
            return 1.0

        try:
            # Get context embeddings
            context_embeddings = await self._get_embeddings_batch(contexts)

            # Calculate pairwise similarities
            pairwise_similarities = []
            n = len(context_embeddings)
            for i in range(n):
                for j in range(i + 1, n):
                    similarity = self._cosine_similarity(
                        context_embeddings[i], context_embeddings[j]
                    )
                    # Normalize to 0-1 range
                    normalized_sim = (similarity + 1) / 2
                    pairwise_similarities.append(normalized_sim)

            # Calculate average pairwise similarity
            if not pairwise_similarities:
                return 1.0

            avg_similarity = sum(pairwise_similarities) / len(pairwise_similarities)

            # Diversity = 1 - average similarity
            diversity = 1.0 - avg_similarity

            return max(0.0, min(1.0, diversity))

        except Exception as e:
            logger.error(
                "Failed to evaluate context_diversity",
                error_type=type(e).__name__,
                error=str(e),
                contexts_count=len(contexts),
            )
            return None

    async def evaluate_all(
        self,
        query: str,
        contexts: List[str],
    ) -> Dict[str, Any]:
        """
        Evaluate all embedding-based metrics.

        Args:
            query: The user's question
            contexts: List of retrieved context chunks

        Returns:
            Dictionary containing all metric scores
        """
        # Log start of evaluation with configuration info
        logger.info(
            "Starting RAGAS embedding metrics evaluation",
            query_length=len(query),
            contexts_count=len(contexts),
            embedding_model=settings.RAGAS_EMBEDDING_MODEL,
            embedding_base_url=settings.RAGAS_EMBEDDING_BASE_URL,
            api_key_configured=bool(settings.RAGAS_EMBEDDING_API_KEY and settings.RAGAS_EMBEDDING_API_KEY != "your_openai_api_key"),
        )

        # Run all evaluations concurrently
        results = await asyncio.gather(
            self.evaluate_query_context_relevance(query, contexts),
            self.evaluate_context_precision(query, contexts),
            self.evaluate_context_diversity(contexts),
            return_exceptions=True,
        )

        # Process results and log any exceptions
        processed_results = {}
        metric_names = ["query_context_relevance", "context_precision_emb", "context_diversity"]

        for i, (name, result) in enumerate(zip(metric_names, results)):
            if isinstance(result, Exception):
                logger.error(
                    f"RAGAS embedding metric {name} raised exception",
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
                "RAGAS embedding evaluation completed with null metrics",
                null_metrics=null_metrics,
                successful_metrics=[name for name, val in processed_results.items() if val is not None],
            )
        else:
            logger.info(
                "RAGAS embedding evaluation completed successfully",
                results=processed_results,
            )

        return processed_results


# Global evaluator instance
embedding_metrics_evaluator = EmbeddingMetricsEvaluator()
