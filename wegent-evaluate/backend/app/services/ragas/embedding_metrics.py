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
        """Get embedding for a text string."""
        # Truncate text if too long (most embedding models have token limits)
        max_chars = 8000
        if len(text) > max_chars:
            text = text[:max_chars]

        embedding = await asyncio.to_thread(
            self.embeddings.embed_query, text
        )
        return embedding

    async def _get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        """Get embeddings for multiple texts."""
        # Truncate texts if too long
        max_chars = 8000
        truncated_texts = [t[:max_chars] if len(t) > max_chars else t for t in texts]

        embeddings = await asyncio.to_thread(
            self.embeddings.embed_documents, truncated_texts
        )
        return embeddings

    async def evaluate_query_context_relevance(
        self,
        query: str,
        contexts: List[str],
    ) -> float:
        """
        Evaluate query-context relevance using embedding similarity.

        This metric measures how semantically relevant the retrieved contexts
        are to the user's query.

        Args:
            query: The user's question
            contexts: List of retrieved context chunks

        Returns:
            Score between 0 and 1 (higher is better)
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
            logger.exception("Failed to evaluate query_context_relevance", error=str(e))
            return None

    async def evaluate_context_precision(
        self,
        query: str,
        contexts: List[str],
        relevance_threshold: float = 0.5,
    ) -> float:
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
            Score between 0 and 1 (higher is better)
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
            logger.exception("Failed to evaluate context_precision", error=str(e))
            return None

    async def evaluate_context_diversity(
        self,
        contexts: List[str],
    ) -> float:
        """
        Evaluate context diversity using pairwise embedding similarity.

        This metric measures how diverse the retrieved contexts are.
        High diversity means the contexts cover different aspects of the topic.

        Formula: diversity = 1 - average_pairwise_similarity

        Args:
            contexts: List of retrieved context chunks

        Returns:
            Score between 0 and 1 (higher means more diverse)
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
            logger.exception("Failed to evaluate context_diversity", error=str(e))
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
        # Run all evaluations concurrently
        results = await asyncio.gather(
            self.evaluate_query_context_relevance(query, contexts),
            self.evaluate_context_precision(query, contexts),
            self.evaluate_context_diversity(contexts),
            return_exceptions=True,
        )

        return {
            "query_context_relevance": results[0] if not isinstance(results[0], Exception) else None,
            "context_precision_emb": results[1] if not isinstance(results[1], Exception) else None,
            "context_diversity": results[2] if not isinstance(results[2], Exception) else None,
        }


# Global evaluator instance
embedding_metrics_evaluator = EmbeddingMetricsEvaluator()
