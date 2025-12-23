# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge retrieval service for chat integration.

This module provides RAG (Retrieval-Augmented Generation) functionality for chat,
integrating with the existing RAG infrastructure to retrieve relevant content from
knowledge bases and synthesize it into LLM prompts.
"""

import logging
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

# RAG retrieval constants for chat knowledge integration
# These values are for initial implementation and debugging
# TODO: In the future, these should be read from Retriever configuration
RAG_TOP_K = 5
RAG_SCORE_THRESHOLD = 0.7
RAG_MAX_TOKENS = 2000
RAG_RETRIEVAL_MODE = "hybrid"  # 'vector', 'keyword', or 'hybrid'
RAG_VECTOR_WEIGHT = 0.7
RAG_KEYWORD_WEIGHT = 0.3

logger = logging.getLogger(__name__)


class KnowledgeBaseRef:
    """Reference to a knowledge base for RAG retrieval."""

    def __init__(self, knowledge_base_id: int, name: str):
        """
        Initialize knowledge base reference.

        Args:
            knowledge_base_id: Knowledge base ID
            name: Knowledge base name (for display)
        """
        self.knowledge_base_id = knowledge_base_id
        self.name = name


class Citation:
    """Document citation information."""

    def __init__(
        self,
        document_id: int,
        knowledge_base_id: int,
        knowledge_base_name: str,
        document_name: str,
        snippet: str,
        score: float,
    ):
        """
        Initialize citation.

        Args:
            document_id: Document ID
            knowledge_base_id: Knowledge base ID
            knowledge_base_name: Knowledge base name
            document_name: Document name
            snippet: Text snippet preview
            score: Relevance score
        """
        self.document_id = document_id
        self.knowledge_base_id = knowledge_base_id
        self.knowledge_base_name = knowledge_base_name
        self.document_name = document_name
        self.snippet = snippet
        self.score = score

    def to_dict(self):
        """Convert to dictionary for JSON serialization."""
        return {
            "document_id": self.document_id,
            "knowledge_base_id": self.knowledge_base_id,
            "knowledge_base_name": self.knowledge_base_name,
            "document_name": self.document_name,
            "snippet": self.snippet,
            "score": self.score,
        }


class ChatKnowledgeRetriever:
    """LlamaIndex QueryEngine-style knowledge retriever for chat."""

    def __init__(self, db: Session, user_id: int):
        """
        Initialize chat knowledge retriever.

        Args:
            db: Database session
            user_id: User ID for permission checks
        """
        self.db = db
        self.user_id = user_id

    async def retrieve_and_synthesize(
        self, query: str, knowledge_bases: List[KnowledgeBaseRef]
    ) -> Tuple[str, List[Citation], bool]:
        """
        Retrieve from knowledge bases and synthesize context.

        This method implements a LlamaIndex QueryEngine-style workflow:
        1. Retrieve chunks from each knowledge base
        2. Deduplicate and merge results
        3. Synthesize context in a structured format
        4. Extract citation metadata

        Args:
            query: User's search query
            knowledge_bases: List of knowledge base references

        Returns:
            Tuple of:
            - synthesized_context: Context text to append to prompt
            - citations: List of document citations
            - has_results: Whether any results were found
        """
        all_chunks = []
        citations = []

        # 1. Iterate through knowledge bases and retrieve
        for kb_ref in knowledge_bases:
            try:
                # Verify access permission
                kb = await self._get_knowledge_base(kb_ref.knowledge_base_id)
                if not kb:
                    logger.warning(
                        f"Knowledge base {kb_ref.knowledge_base_id} not found or access denied"
                    )
                    continue

                # Get retriever from knowledge base spec
                retriever_ref = self._get_retriever_from_kb(kb)
                if not retriever_ref:
                    logger.warning(
                        f"No retriever configured for knowledge base {kb_ref.name}"
                    )
                    continue

                # Retrieve chunks using existing RAG service
                chunks = await self._retrieve_chunks(
                    retriever_ref=retriever_ref,
                    query=query,
                    knowledge_id=str(kb_ref.knowledge_base_id),
                    kb_name=kb_ref.name,
                )

                all_chunks.extend(chunks)
            except Exception as e:
                logger.warning(f"Failed to retrieve from KB {kb_ref.name}: {e}")
                continue

        if not all_chunks:
            return "", [], False

        # 2. Deduplicate and rerank (optional)
        deduplicated_chunks = self._deduplicate(all_chunks)

        # 3. Synthesize context (LlamaIndex style)
        context = self._synthesize_context(deduplicated_chunks)

        # 4. Extract citation info
        citations = self._extract_citations(deduplicated_chunks)

        return context, citations, True

    def _synthesize_context(self, chunks: List[dict]) -> str:
        """
        Synthesize context in LlamaIndex QueryEngine style.

        Format:
        ---
        Retrieved Context from Knowledge Bases:

        [Document 1: {document_name}]
        {content}

        [Document 2: {document_name}]
        {content}
        ---

        Args:
            chunks: List of retrieved chunks

        Returns:
            Synthesized context string
        """
        context_parts = ["Retrieved Context from Knowledge Bases:", ""]

        total_tokens = 0
        max_tokens = RAG_MAX_TOKENS

        for i, chunk in enumerate(chunks, 1):
            doc_name = chunk.get("metadata", {}).get(
                "document_name", f"Document {i}"
            )
            content = chunk.get("text", "")

            # Simple token estimation (1 token ≈ 4 characters)
            chunk_tokens = len(content) // 4

            if max_tokens and (total_tokens + chunk_tokens) > max_tokens:
                logger.info(
                    f"Reached max tokens limit ({max_tokens}), stopping at chunk {i}"
                )
                break

            context_parts.append(f"[Document {i}: {doc_name}]")
            context_parts.append(content)
            context_parts.append("")

            total_tokens += chunk_tokens

        full_context = "\n".join(context_parts)
        return full_context

    async def _retrieve_chunks(
        self,
        retriever_ref: dict,
        query: str,
        knowledge_id: str,
        kb_name: str,
    ) -> List[dict]:
        """
        Call existing RAG retrieval service.

        Args:
            retriever_ref: Retriever reference dict with name and namespace
            query: Search query
            knowledge_id: Knowledge base ID as string
            kb_name: Knowledge base name

        Returns:
            List of retrieved chunks with metadata
        """
        from app.services.rag.retrieval_service import RetrievalService
        from app.services.rag.storage.factory import create_storage_backend_from_crd

        # Create storage backend from retriever CRD
        storage_backend = create_storage_backend_from_crd(
            db=self.db,
            user_id=self.user_id,
            retriever_name=retriever_ref["name"],
            retriever_namespace=retriever_ref["namespace"],
        )

        # Create retrieval service
        retrieval_service = RetrievalService(storage_backend=storage_backend)

        # Get embedding config from retriever or use default
        embedding_config = self._get_embedding_config(retriever_ref)

        # Use constants defined at module level
        hybrid_weights = None
        if RAG_RETRIEVAL_MODE == "hybrid":
            hybrid_weights = {
                "vector_weight": RAG_VECTOR_WEIGHT,
                "keyword_weight": RAG_KEYWORD_WEIGHT,
            }

        # Call retrieval service
        result = await retrieval_service.retrieve(
            query=query,
            knowledge_id=knowledge_id,
            embedding_model_name=embedding_config["model_name"],
            embedding_model_namespace=embedding_config["model_namespace"],
            user_id=self.user_id,
            db=self.db,
            top_k=RAG_TOP_K,
            score_threshold=RAG_SCORE_THRESHOLD,
            retrieval_mode=RAG_RETRIEVAL_MODE,
            vector_weight=hybrid_weights["vector_weight"]
            if hybrid_weights
            else None,
            keyword_weight=hybrid_weights["keyword_weight"]
            if hybrid_weights
            else None,
        )

        # Convert Dify-style result to internal format
        chunks = []
        for record in result.get("records", []):
            chunk = {
                "text": record.get("content", ""),
                "score": record.get("score", 0.0),
                "metadata": {
                    "document_name": record.get("title", "Unknown"),
                    "knowledge_base_name": kb_name,
                    "knowledge_base_id": int(knowledge_id),
                    # Extract document_id from metadata if available
                    "document_id": record.get("metadata", {}).get("document_id", 0),
                },
            }
            chunks.append(chunk)

        return chunks

    async def _get_knowledge_base(self, knowledge_base_id: int):
        """
        Get knowledge base with permission check.

        Args:
            knowledge_base_id: Knowledge base ID

        Returns:
            Knowledge base Kind object or None if not found/no access
        """
        from app.services.knowledge_service import KnowledgeService

        kb = KnowledgeService.get_knowledge_base(
            db=self.db,
            knowledge_base_id=knowledge_base_id,
            user_id=self.user_id,
        )

        return kb

    def _get_retriever_from_kb(self, kb) -> Optional[dict]:
        """
        Extract retriever reference from knowledge base spec.

        Args:
            kb: Knowledge base Kind object

        Returns:
            Retriever reference dict or None if not configured
        """
        spec = kb.json.get("spec", {})
        retriever_ref = spec.get("retrieverRef")

        if not retriever_ref:
            return None

        return {
            "name": retriever_ref.get("name"),
            "namespace": retriever_ref.get("namespace", "default"),
        }

    def _get_embedding_config(self, retriever_ref: dict) -> dict:
        """
        Get embedding config from retriever or use default.

        Args:
            retriever_ref: Retriever reference dict

        Returns:
            Embedding config dict with model_name and model_namespace
        """
        # TODO: Fetch from retriever's embedding configuration
        # For now, use system default - this assumes an embedding model exists
        # with these values in the Kind table
        return {"model_name": "default-embedding", "model_namespace": "default"}

    def _deduplicate(self, chunks: List[dict]) -> List[dict]:
        """
        Deduplicate chunks based on document_id + chunk index.

        Args:
            chunks: List of chunks

        Returns:
            Deduplicated list of chunks
        """
        seen = set()
        deduplicated = []

        for chunk in chunks:
            chunk_id = (
                chunk.get("metadata", {}).get("document_id"),
                chunk.get("metadata", {}).get("chunk_index"),
            )

            if chunk_id not in seen:
                seen.add(chunk_id)
                deduplicated.append(chunk)

        return deduplicated

    def _extract_citations(self, chunks: List[dict]) -> List[Citation]:
        """
        Extract citation information from chunks.

        Args:
            chunks: List of chunks

        Returns:
            List of Citation objects
        """
        citations = []

        for chunk in chunks:
            metadata = chunk.get("metadata", {})
            citations.append(
                Citation(
                    document_id=metadata.get("document_id", 0),
                    knowledge_base_id=metadata.get("knowledge_base_id", 0),
                    knowledge_base_name=metadata.get("knowledge_base_name", ""),
                    document_name=metadata.get("document_name", "Unknown"),
                    snippet=chunk.get("text", "")[:200],  # Limit snippet length
                    score=chunk.get("score", 0.0),
                )
            )

        return citations


async def build_prompt_with_knowledge(
    user_message: str,
    knowledge_context: str,
    has_knowledge_results: bool,
) -> str:
    """
    Build prompt with knowledge context (LlamaIndex QueryEngine style).

    Format:

    Context information is below:
    ---------------------
    {knowledge_context}
    ---------------------

    Given the context information and not prior knowledge, answer the query.
    If the context doesn't contain relevant information, say so and answer based on your general knowledge.

    Query: {user_message}
    Answer:

    Args:
        user_message: User's original message
        knowledge_context: Retrieved knowledge context
        has_knowledge_results: Whether knowledge retrieval returned results

    Returns:
        Final prompt string
    """
    if not has_knowledge_results:
        return user_message

    prompt = f"""Context information is below:
---------------------
{knowledge_context}
---------------------

Given the context information and not prior knowledge, answer the query.
If the context doesn't contain relevant information, say so and answer based on your general knowledge.

Query: {user_message}
Answer:"""

    return prompt
