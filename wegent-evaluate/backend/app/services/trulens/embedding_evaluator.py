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
        """Get embedding for a text string."""
        max_chars = 8000
        if len(text) > max_chars:
            text = text[:max_chars]

        embedding = await asyncio.to_thread(
            self.embeddings.embed_query, text
        )
        return embedding

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
            Score between 0 and 1 (higher is better)
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
            logger.exception("Failed to evaluate TruLens context_relevance", error=str(e))
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
            Score between 0 and 1 (higher is better)
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
            logger.exception("Failed to evaluate TruLens relevance (embedding)", error=str(e))
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
        results = await asyncio.gather(
            self.evaluate_context_relevance(query, contexts),
            self.evaluate_relevance(query, answer),
            return_exceptions=True,
        )

        return {
            "context_relevance": results[0] if not isinstance(results[0], Exception) else None,
            "relevance_embedding": results[1] if not isinstance(results[1], Exception) else None,
        }


# Global evaluator instance
trulens_embedding_evaluator = TruLensEmbeddingEvaluator()
