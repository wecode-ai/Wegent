# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document read methods of the legacy Milvus adapter.

This is the online main branch's implementation, moved into its own module so
the adapter stays within the repository's file size rule. The class below is a
mixin of ``LegacyMilvusBackend``: it reads the collection name, the LlamaIndex
vector store and the Milvus client off that adapter.
"""

import logging
from typing import Any, Dict, List, Optional

from llama_index.core.vector_stores import MetadataFilter, MetadataFilters
from llama_index.core.vector_stores.types import FilterOperator

from knowledge_engine.retrieval.filters import filter_chunk_records
from knowledge_engine.storage.milvus_legacy.constants import MAX_QUERY_LIMIT

logger = logging.getLogger(__name__)


class LegacyMilvusDocumentReads:
    """Reads of one knowledge base's indexed documents and chunks."""

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Get document details from Milvus using LlamaIndex API.

        Uses get_nodes with metadata filters to retrieve all chunks
        with matching doc_ref.

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)
            **kwargs: Additional parameters

        Returns:
            Document details dict with chunks
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        vector_store = self.create_vector_store(collection_name)

        # Build filters to match the document
        filters = self._build_doc_ref_filters(knowledge_id, doc_ref)

        # Get nodes using LlamaIndex API
        nodes = vector_store.get_nodes(filters=filters)

        if not nodes:
            raise ValueError(f"Document {doc_ref} not found")

        # Extract chunks and sort by chunk_index
        chunks = []
        source_file = None
        for node in nodes:
            metadata = node.metadata

            if source_file is None:
                source_file = metadata.get("source_file")

            chunks.append(
                {
                    "chunk_index": metadata.get("chunk_index"),
                    "content": self.get_node_display_text(node),
                    "metadata": metadata,
                }
            )

        # Sort by chunk_index
        chunks.sort(key=lambda x: x.get("chunk_index", 0))

        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "source_file": source_file,
            "chunk_count": len(chunks),
            "chunks": chunks,
        }

    def _build_doc_ref_filters(self, knowledge_id: str, doc_ref: str):
        """
        Build metadata filters for document reference lookup.

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)

        Returns:
            MetadataFilters object for filtering by knowledge_id and doc_ref
        """
        return MetadataFilters(
            filters=[
                MetadataFilter(
                    key="knowledge_id", value=knowledge_id, operator=FilterOperator.EQ
                ),
                MetadataFilter(
                    key="doc_ref", value=doc_ref, operator=FilterOperator.EQ
                ),
            ],
            condition="and",
        )

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """
        List documents in Milvus collection.

        Uses MilvusClient directly for aggregation functionality.

        Args:
            knowledge_id: Knowledge base ID
            page: Page number
            page_size: Page size
            **kwargs: Additional parameters

        Returns:
            Document list dict
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        client = None

        try:
            # Create MilvusClient for direct query
            client = self._get_client()

            # Check if collection exists
            collections = client.list_collections()
            if collection_name not in collections:
                return {
                    "documents": [],
                    "total": 0,
                    "page": page,
                    "page_size": page_size,
                    "knowledge_id": knowledge_id,
                }

            # Sanitize knowledge_id to prevent expression injection
            safe_knowledge_id = self._sanitize_filter_value(knowledge_id)
            filter_expr = f'knowledge_id == "{safe_knowledge_id}"'

            # Query all records with matching knowledge_id
            # Note: Milvus requires specifying output fields
            results = client.query(
                collection_name=collection_name,
                filter=filter_expr,
                output_fields=["doc_ref", "source_file", "created_at", "chunk_index"],
                limit=MAX_QUERY_LIMIT,
            )

            # Warn if results may be truncated
            if len(results) >= MAX_QUERY_LIMIT:
                logger.warning(
                    f"[Milvus] Knowledge base {knowledge_id} has >= {MAX_QUERY_LIMIT} "
                    "chunks; document listing may be incomplete."
                )

            # Aggregate by doc_ref
            doc_map: Dict[str, Dict] = {}
            for record in results:
                doc_ref = record.get("doc_ref")
                if not doc_ref:
                    continue

                if doc_ref not in doc_map:
                    doc_map[doc_ref] = {
                        "doc_ref": doc_ref,
                        "source_file": record.get("source_file"),
                        "chunk_count": 0,
                        "created_at": record.get("created_at"),
                    }
                doc_map[doc_ref]["chunk_count"] += 1

            # Convert to list and sort by created_at
            all_docs = list(doc_map.values())
            all_docs.sort(key=lambda x: x.get("created_at") or "", reverse=True)

            # Pagination
            total = len(all_docs)
            start = (page - 1) * page_size
            end = start + page_size
            documents = all_docs[start:end]

            return {
                "documents": documents,
                "total": total,
                "page": page,
                "page_size": page_size,
                "knowledge_id": knowledge_id,
            }

        except Exception as e:
            logger.warning(
                f"[Milvus] Failed to list documents for KB {knowledge_id}: {e}"
            )
            return {
                "documents": [],
                "total": 0,
                "page": page,
                "page_size": page_size,
                "knowledge_id": knowledge_id,
            }
        finally:
            # Ensure client is closed to avoid connection leaks
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def get_all_chunks(
        self,
        knowledge_id: str,
        max_chunks: int = MAX_QUERY_LIMIT,
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """
        Get all chunks from a knowledge base in Milvus.

        Uses MilvusClient directly for efficient batch retrieval.

        Args:
            knowledge_id: Knowledge base ID
            max_chunks: Maximum number of chunks to retrieve (safety limit)
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            List of chunk dicts with content, title, chunk_id, doc_ref, metadata
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        client = None

        try:
            # Create MilvusClient for direct query
            client = self._get_client()

            # Check if collection exists
            collections = client.list_collections()
            if collection_name not in collections:
                return []

            # Sanitize knowledge_id to prevent expression injection
            safe_knowledge_id = self._sanitize_filter_value(knowledge_id)
            filter_expr = f'knowledge_id == "{safe_knowledge_id}"'

            # Query all records with matching knowledge_id
            results = client.query(
                collection_name=collection_name,
                filter=filter_expr,
                output_fields=[
                    "doc_ref",
                    "source_file",
                    "created_at",
                    "chunk_index",
                    "text",
                    "display_text",
                ],
                limit=max_chunks,
            )

            # Convert to chunk format
            chunks = []
            for record in results:
                # Get text content - try 'text' field first, then fallback
                raw_content = record.get("text", "")

                chunks.append(
                    {
                        "content": self.get_display_text_from_metadata(
                            record,
                            fallback=self.extract_chunk_text(raw_content),
                        ),
                        "title": record.get("source_file", ""),
                        "chunk_id": record.get("chunk_index", 0),
                        "doc_ref": record.get("doc_ref", ""),
                        "metadata": record,
                    }
                )

            # Sort by doc_ref and chunk_index
            chunks.sort(key=lambda x: (x.get("doc_ref", ""), x.get("chunk_id", 0)))

            filtered_chunks = filter_chunk_records(chunks, metadata_condition)
            return filtered_chunks[:max_chunks]

        except Exception as e:
            logger.warning(
                f"[Milvus] Failed to get all chunks for KB {knowledge_id}: {e}"
            )
            return []
        finally:
            # Ensure client is closed to avoid connection leaks
            if client:
                try:
                    client.close()
                except Exception:
                    pass
