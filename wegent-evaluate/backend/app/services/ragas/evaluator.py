"""
RAGAS evaluator for RAG quality assessment.
"""
import asyncio
import time
from typing import Any, Dict

import structlog
from langchain_core.messages import AIMessage, HumanMessage
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from ragas import EvaluationDataset, SingleTurnSample, evaluate
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.metrics import (
    Faithfulness,
    LLMContextPrecisionWithoutReference,
    ResponseRelevancy,
)

from app.core.config import settings

logger = structlog.get_logger(__name__)


class RAGASEvaluator:
    """RAGAS evaluator for RAG quality assessment."""

    def __init__(self):
        self._llm = None
        self._embeddings = None

    @property
    def llm(self):
        """Get or create LLM instance."""
        if self._llm is None:
            base_llm = ChatOpenAI(
                model=settings.RAGAS_LLM_MODEL,
                api_key=settings.RAGAS_LLM_API_KEY,
                base_url=settings.RAGAS_LLM_BASE_URL,
                temperature=0,
            )
            self._llm = LangchainLLMWrapper(base_llm)
        return self._llm

    @property
    def embeddings(self):
        """Get or create embeddings instance."""
        if self._embeddings is None:
            base_embeddings = OpenAIEmbeddings(
                model=settings.RAGAS_EMBEDDING_MODEL,
                api_key=settings.RAGAS_EMBEDDING_API_KEY,
                base_url=settings.RAGAS_EMBEDDING_BASE_URL,
            )
            self._embeddings = LangchainEmbeddingsWrapper(base_embeddings)
        return self._embeddings

    async def evaluate(
        self,
        user_prompt: str,
        assistant_answer: str,
        extracted_text: str,
    ) -> Dict[str, Any]:
        """
        Evaluate a single RAG response using RAGAS metrics.

        Args:
            user_prompt: The user's question
            assistant_answer: The AI's response
            extracted_text: The retrieved context used for the response

        Returns:
            Dictionary containing:
            - faithfulness_score: How faithful the answer is to the context
            - answer_relevancy_score: How relevant the answer is to the question
            - context_precision_score: Quality of the retrieved context
            - overall_score: Average of all scores
            - raw_result: Raw RAGAS evaluation result
            - duration_ms: Evaluation duration in milliseconds
        """
        start_time = time.time()

        try:
            # Create RAGAS sample
            sample = SingleTurnSample(
                user_input=user_prompt,
                response=assistant_answer,
                retrieved_contexts=[extracted_text],
            )

            # Create dataset
            dataset = EvaluationDataset(samples=[sample])

            # Define metrics
            metrics = [
                Faithfulness(llm=self.llm),
                ResponseRelevancy(llm=self.llm, embeddings=self.embeddings),
                LLMContextPrecisionWithoutReference(llm=self.llm),
            ]

            # Run evaluation in a separate thread to avoid nested event loop issues
            # RAGAS evaluate() internally uses asyncio which conflicts with uvloop
            result = await asyncio.to_thread(
                evaluate,
                dataset=dataset,
                metrics=metrics,
            )

            # Extract scores
            result_df = result.to_pandas()
            row = result_df.iloc[0]

            faithfulness_score = (
                float(row["faithfulness"])
                if "faithfulness" in row and row["faithfulness"] is not None
                else None
            )
            answer_relevancy_score = (
                float(row["answer_relevancy"])
                if "answer_relevancy" in row and row["answer_relevancy"] is not None
                else None
            )
            context_precision_score = (
                float(row["llm_context_precision_without_reference"])
                if "llm_context_precision_without_reference" in row
                and row["llm_context_precision_without_reference"] is not None
                else None
            )

            # Calculate overall score (average of available scores)
            scores = [
                s
                for s in [
                    faithfulness_score,
                    answer_relevancy_score,
                    context_precision_score,
                ]
                if s is not None
            ]
            overall_score = sum(scores) / len(scores) if scores else None

            duration_ms = int((time.time() - start_time) * 1000)

            return {
                "faithfulness_score": faithfulness_score,
                "answer_relevancy_score": answer_relevancy_score,
                "context_precision_score": context_precision_score,
                "overall_score": overall_score,
                "raw_result": result_df.to_dict(orient="records")[0],
                "duration_ms": duration_ms,
                "model": settings.RAGAS_LLM_MODEL,
            }

        except Exception as e:
            logger.exception("RAGAS evaluation failed", error=str(e))
            duration_ms = int((time.time() - start_time) * 1000)
            raise


# Global evaluator instance
ragas_evaluator = RAGASEvaluator()
