# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus storage backend built directly on the official synchronous PyMilvus.

Scope: dense vector write, retrieval and delete for ordinary documents, plus
the server-maintained index contract that binds a collection to its embedding
space, schema and keyword analyzer. Collections are created only by the
explicit index write path; queries, reads and deletes never create resources.

Two retrieval modes are served from one physical collection: ``vector`` uses
the stored dense vectors with their raw COSINE score, and ``keyword`` uses the
server-side BM25 sparse field built over the analyzed retrieval text, so it
never asks the embedding provider for a query vector. Weighted ``hybrid``
retrieval is a later slice and raises an explicit unsupported-capability error
instead of silently degrading to a different scoring mode. The embedding space
contract makes a same-dimension model swap an explicit failure rather than a
silent quality regression.
"""

import json
import logging
import math
from typing import Any, Callable, ClassVar, Dict, List, Optional, Sequence

from llama_index.core.schema import BaseNode
from pymilvus import MilvusClient

from knowledge_engine.embedding.space import compute_embedding_space
from knowledge_engine.embedding.vectors import (
    EmptyIndexableContentError,
    prepare_query_vector,
    prepare_text_vectors,
    read_model_name,
    validate_vectors,
)
from knowledge_engine.retrieval.filters import filter_chunk_records
from knowledge_engine.retrieval.search_hints import resolve_search_queries
from knowledge_engine.storage.base import (
    DISPLAY_TEXT_METADATA_KEY,
    BaseStorageBackend,
)
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
    IndexRollbackError,
    StorageBackendError,
    UnsupportedStorageCapabilityError,
)
from knowledge_engine.storage.milvus_filters import compile_metadata_conditions
from knowledge_engine.storage.milvus_native import (
    ATTEMPT_ID_FIELD,
    CHUNK_FIELDS_FOR_FILTERING,
    CHUNK_INDEX_FIELD,
    CREATED_AT_FIELD,
    DENSE_VECTOR_FIELD,
    DISPLAY_TEXT_FIELD,
    DOC_REF_FIELD,
    GENERATION_FIELD,
    ID_FIELD,
    KNOWLEDGE_ID_FIELD,
    METADATA_FIELD,
    NODE_KIND_CHUNK,
    NODE_KIND_FIELD,
    PUBLISHED_FIELD,
    RETRIEVAL_TEXT_FIELD,
    SCHEMA_VERSION,
    SOURCE_FILE_FIELD,
    MilvusDocumentStore,
    build_scope_filter,
    contract_token_field,
    node_row_id,
    sanitize_filter_value,
)
from knowledge_engine.storage.milvus_parent_store import MilvusParentStore
from shared.models import RetrievalScope

logger = logging.getLogger(__name__)

DEFAULT_TOP_K = 20
DEFAULT_SCORE_THRESHOLD = 0.7
MAX_QUERY_LIMIT = 10000
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_ATTEMPT_PREFIX = "gen"


def keyword_relevance_score(raw_score: float) -> float:
    """Map a non-negative BM25 score onto the shared 0..1 relevance scale.

    The mapping is fixed and monotonic (``score / (1 + score)``) instead of
    being derived from the candidate set, so the same document keeps the same
    score regardless of which other documents matched.
    """
    if not math.isfinite(raw_score) or raw_score <= 0.0:
        return 0.0
    return raw_score / (1.0 + raw_score)


class MilvusBackend(BaseStorageBackend):
    """Dense Milvus storage backend using the official synchronous SDK."""

    SUPPORTED_RETRIEVAL_METHODS: ClassVar[List[str]] = ["vector", "keyword"]
    supports_retrieval_scope: ClassVar[bool] = True
    INDEX_PREFIX: ClassVar[str] = "collection"

    def __init__(self, config: Dict):
        """Initialize the backend from a resolved retriever storage config.

        Args:
            config: Storage configuration dict containing:
                - url: Milvus connection URL with optional db_name path
                  (e.g., "http://localhost:19530/mydb" or "http://localhost:19530")
                - username: Optional username for authentication
                - password: Optional password for authentication
                - indexStrategy: Index/collection naming strategy
                - ext: Additional config (e.g., dim, db_name, timeout)
        """
        super().__init__(config)

        # The dimension is a validation input only; the first real vector
        # decides the physical schema and there is no default dimension.
        self.dim = self.ext.get("dim")

        if self.username and self.password:
            self.token = f"{self.username}:{self.password}"
        else:
            self.token = ""

        self.db_name, self.base_url = self._parse_db_name_from_url(self.url)
        self._store = MilvusDocumentStore(
            uri=self.base_url,
            token=self.token,
            db_name=self.db_name,
            timeout=float(self.ext.get("timeout") or DEFAULT_TIMEOUT_SECONDS),
        )
        self._parent_store = MilvusParentStore(
            store=self._store,
            collection_name_for=self.get_parent_store_name,
            display_text_for=self.get_node_display_text,
        )

    def _parse_db_name_from_url(self, url: str) -> tuple[str, str]:
        """Split the database name out of the connection URL.

        Priority for db_name:
        1. ext.db_name - explicit config takes highest priority
        2. URL path - extracted from URL if present
        3. Default - "default" if not specified
        """
        from urllib.parse import urlparse, urlunparse

        if self.ext.get("db_name"):
            return self.ext["db_name"], url

        if not url:
            return "default", url

        parsed = urlparse(url)
        # A local Milvus Lite path (``/tmp/contract.db``) is a URI without a
        # scheme; its path is the database file, not a database name.
        if not parsed.scheme:
            return "default", url
        path = parsed.path.strip("/")
        if path:
            base_url = urlunparse(
                (parsed.scheme, parsed.netloc, "", parsed.params, parsed.query, "")
            )
            return path, base_url
        return "default", url

    def create_vector_store(self, collection_name: str, **kwargs) -> Any:
        """Milvus no longer exposes a LlamaIndex vector store."""
        del collection_name, kwargs
        raise UnsupportedStorageCapabilityError(
            "llama_index vector store", backend="milvus"
        )

    def index_with_metadata(
        self,
        nodes: List[BaseNode],
        chunk_metadata: ChunkMetadata,
        embed_model,
        **kwargs,
    ) -> Dict:
        """Write and publish one document execution into Milvus.

        Rows are written unpublished, verified through an independent client
        and only then published. A failure anywhere leaves the document
        invisible instead of exposing a half-written index.
        """
        materialized = [node for node in nodes if self._node_has_content(node)]
        if not materialized:
            raise EmptyIndexableContentError()

        knowledge_id = chunk_metadata.knowledge_id
        doc_ref = chunk_metadata.doc_ref
        generation = self._resolve_generation(kwargs)
        attempt_id = self._resolve_attempt_id(kwargs, generation)
        collection_name = self.get_index_name(knowledge_id, **kwargs)

        vectors = self._resolve_node_vectors(materialized, embed_model)
        dimension = len(vectors[0])
        embedding_space = compute_embedding_space(embed_model)

        rows = [
            self._build_row(
                node,
                vector,
                knowledge_id=knowledge_id,
                doc_ref=doc_ref,
                generation=generation,
                attempt_id=attempt_id,
                embedding_space=embedding_space,
            )
            for node, vector in zip(materialized, vectors)
        ]

        self._write_unpublished(
            collection_name,
            rows,
            dimension=dimension,
            embedding_space=embedding_space,
            execution_filter=self._execution_filter(
                knowledge_id, doc_ref, attempt_id, published=False
            ),
        )
        self._publish_rows(
            collection_name,
            rows,
            published_filter=self._execution_filter(
                knowledge_id, doc_ref, attempt_id, published=True
            ),
            execution_filter=self._execution_filter(
                knowledge_id, doc_ref, attempt_id, published=False
            ),
        )

        logger.info(
            "[Milvus] Published document: collection=%s, doc_ref=%s, generation=%s, "
            "attempt=%s, chunks=%d, dimension=%d",
            collection_name,
            doc_ref,
            generation,
            attempt_id,
            len(rows),
            dimension,
        )
        return {
            "indexed_count": len(rows),
            "index_name": collection_name,
            "status": "success",
            "dimension": dimension,
            "embedding_space": embedding_space,
        }

    def _write_unpublished(
        self,
        collection_name: str,
        rows: List[Dict[str, Any]],
        *,
        dimension: int,
        embedding_space: str,
        execution_filter: str,
    ) -> None:
        """Create the index if needed and stage every row unpublished."""
        with self._store.client() as client:
            self._store.ensure_index(
                client,
                collection_name,
                dimension=dimension,
                embedding_space=embedding_space,
            )
            self._store.upsert_rows(
                client, collection_name, self._with_publication(rows, published=False)
            )
            self._store.flush(client, collection_name)
        self._assert_visible_row_count(
            collection_name, execution_filter, expected=len(rows), stage="write"
        )

    def _publish_rows(
        self,
        collection_name: str,
        rows: List[Dict[str, Any]],
        *,
        published_filter: str,
        execution_filter: str,
    ) -> None:
        """Publish a fully written execution and verify its visibility.

        The publication write is the last mutation of the write path, so a
        failure afterwards is rolled back by removing this execution's rows:
        the caller sees the failure and the index does not stay readable for a
        document the business state never marked successful.
        """
        try:
            with self._store.client() as client:
                self._store.upsert_rows(
                    client,
                    collection_name,
                    self._with_publication(rows, published=True),
                )
                self._store.flush(client, collection_name)
            self._assert_visible_row_count(
                collection_name, published_filter, expected=len(rows), stage="publish"
            )
        except Exception as publish_error:
            self._rollback_failed_publication(
                collection_name, execution_filter, publish_error
            )

    def _rollback_failed_publication(
        self,
        collection_name: str,
        execution_filter: str,
        publish_error: Exception,
    ) -> None:
        """Remove a failed execution and re-raise the original failure."""
        try:
            with self._store.client() as client:
                self._store.delete_rows(client, collection_name, execution_filter)
            with self._store.client() as reader:
                remaining = self._store.count_rows(
                    reader, collection_name, execution_filter
                )
            if remaining:
                raise StorageBackendError(
                    "Milvus publication rollback left rows behind.",
                    details={
                        "collection_name": collection_name,
                        "remaining": remaining,
                    },
                )
        except Exception as rollback_error:
            raise IndexRollbackError(
                collection_name,
                details={"rollback_error": str(rollback_error)},
            ) from publish_error
        raise publish_error

    def _resolve_generation(self, kwargs: Dict[str, Any]) -> int:
        generation = kwargs.get("index_generation")
        if generation is None:
            return 0
        return int(generation)

    def _node_has_content(self, node: BaseNode) -> bool:
        """A chunk with neither retrieval nor display text is not indexable."""
        retrieval_text = self.get_node_embedding_text(node)
        display_text = self.get_node_display_text(node)
        return bool(retrieval_text.strip() or display_text.strip())

    def _resolve_attempt_id(self, kwargs: Dict[str, Any], generation: int) -> str:
        attempt_id = kwargs.get("attempt_id")
        if attempt_id:
            return str(attempt_id)
        # Task 01 callers have no persisted attempt yet. A stable value keeps a
        # re-sent batch on the same primary keys, so it overwrites instead of
        # duplicating. Task 02 supplies the persisted execution identity.
        return f"{DEFAULT_ATTEMPT_PREFIX}{generation}"

    def _resolve_node_vectors(
        self,
        nodes: Sequence[BaseNode],
        embed_model,
    ) -> List[List[float]]:
        """Reuse existing node vectors and embed only the missing ones."""
        vectors: List[Optional[List[float]]] = [None] * len(nodes)
        missing_indexes: List[int] = []
        missing_texts: List[str] = []

        for index, node in enumerate(nodes):
            existing = getattr(node, "embedding", None)
            if existing:
                vectors[index] = [float(value) for value in existing]
            else:
                missing_indexes.append(index)
                missing_texts.append(self.get_node_embedding_text(node))

        if missing_indexes:
            prepared = prepare_text_vectors(embed_model, missing_texts)
            for index, vector in zip(missing_indexes, prepared):
                vectors[index] = vector

        resolved = [vector for vector in vectors if vector is not None]
        validate_vectors(
            resolved,
            expected_count=len(nodes),
            expected_dimension=self.dim,
            model_name=read_model_name(embed_model),
        )
        return [vector for vector in vectors if vector is not None]

    def _build_row(
        self,
        node: BaseNode,
        vector: Sequence[float],
        *,
        knowledge_id: str,
        doc_ref: str,
        generation: int,
        attempt_id: str,
        embedding_space: str,
    ) -> Dict[str, Any]:
        metadata = dict(node.metadata or {})
        chunk_index = int(metadata.get("chunk_index") or 0)
        return {
            ID_FIELD: node_row_id(
                knowledge_id=knowledge_id,
                doc_ref=doc_ref,
                generation=generation,
                attempt_id=attempt_id,
                node_kind=NODE_KIND_CHUNK,
                chunk_index=chunk_index,
            ),
            KNOWLEDGE_ID_FIELD: knowledge_id,
            DOC_REF_FIELD: doc_ref,
            SOURCE_FILE_FIELD: str(metadata.get("source_file") or ""),
            GENERATION_FIELD: generation,
            ATTEMPT_ID_FIELD: attempt_id,
            NODE_KIND_FIELD: NODE_KIND_CHUNK,
            CHUNK_INDEX_FIELD: chunk_index,
            RETRIEVAL_TEXT_FIELD: self.get_node_embedding_text(node),
            DISPLAY_TEXT_FIELD: self.get_node_display_text(node),
            METADATA_FIELD: _json_metadata(metadata),
            CREATED_AT_FIELD: str(metadata.get("created_at") or ""),
            PUBLISHED_FIELD: False,
            DENSE_VECTOR_FIELD: [float(value) for value in vector],
            # Constant value; the field name carries the contract identity.
            contract_token_field(embedding_space): "1",
        }

    @staticmethod
    def _with_publication(
        rows: Sequence[Dict[str, Any]], *, published: bool
    ) -> List[Dict[str, Any]]:
        return [{**row, PUBLISHED_FIELD: published} for row in rows]

    @staticmethod
    def _attempt_condition(attempt_id: str) -> str:
        return f'attempt_id == "{sanitize_filter_value(attempt_id)}"'

    def _execution_filter(
        self,
        knowledge_id: str,
        doc_ref: str,
        attempt_id: str,
        *,
        published: bool,
    ) -> str:
        return build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=[doc_ref],
            extra_conditions=[self._attempt_condition(attempt_id)],
            published=published,
        )

    def _assert_visible_row_count(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        expected: int,
        stage: str,
    ) -> None:
        """Verify row count through a separate client before publishing."""
        with self._store.client() as reader:
            actual = self._store.count_rows(reader, collection_name, filter_expr)
        if actual != expected:
            raise StorageBackendError(
                f"Milvus {stage} verification failed: expected {expected} rows "
                f"but an independent client observed {actual}.",
                details={
                    "collection_name": collection_name,
                    "stage": stage,
                    "expected": expected,
                    "actual": actual,
                },
            )

    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        embed_model,
        retrieval_setting: Dict[str, Any],
        scope: Optional[RetrievalScope] = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> Dict:
        """Retrieve published chunks in scope for one retrieval mode.

        ``vector`` returns raw COSINE similarity: the score is the database
        similarity for this candidate with no candidate-set re-normalization.
        ``keyword`` runs server-side BM25 over the analyzed retrieval text and
        maps the raw BM25 score onto the shared relevance scale with the fixed
        ``s / (1 + s)`` mapping. Both modes apply the same knowledge base,
        document and metadata filters inside the database before ``top_k``, and
        both compare the resulting score with ``>=`` against ``score_threshold``.
        """
        retrieval_mode = str(retrieval_setting.get("retrieval_mode") or "vector")
        if retrieval_mode not in self.SUPPORTED_RETRIEVAL_METHODS:
            raise UnsupportedStorageCapabilityError(
                f"{retrieval_mode} retrieval mode", backend="milvus"
            )

        collection_name = self.get_index_name(knowledge_id, **kwargs)
        top_k = int(retrieval_setting.get("top_k") or DEFAULT_TOP_K)
        score_threshold = self._resolve_score_threshold(retrieval_setting)
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=self._scope_doc_refs(scope),
            extra_conditions=compile_metadata_conditions(metadata_condition),
        )
        resolved_queries = resolve_search_queries(query, retrieval_setting)

        # An empty knowledge base answers empty without calling the embedding
        # provider: only a real index justifies a provider request.
        with self._store.client() as client:
            if self._index_is_absent(client, collection_name):
                return {"records": []}

        if retrieval_mode == "keyword":
            return self._keyword_retrieve(
                collection_name=collection_name,
                sparse_query=resolved_queries.sparse_query,
                filter_expr=filter_expr,
                top_k=top_k,
                score_threshold=score_threshold,
            )

        query_vector = prepare_query_vector(embed_model, resolved_queries.dense_query)

        with self._store.client() as client:
            binding = self._store.verify_index(
                client,
                collection_name,
                dimension=len(query_vector),
                embedding_space=compute_embedding_space(embed_model),
            )
            if binding is None:
                raise IndexMissingError(
                    collection_name,
                    "the bound collection disappeared during the query",
                )
            hits = self._store.search(
                client,
                collection_name,
                query_vector=query_vector,
                filter_expr=filter_expr,
                limit=top_k,
            )

        return self._process_hits(hits, score_threshold)

    def _keyword_retrieve(
        self,
        *,
        collection_name: str,
        sparse_query: str,
        filter_expr: str,
        top_k: int,
        score_threshold: float,
    ) -> Dict:
        """Answer a keyword query from the BM25 index alone.

        The embedding provider is not consulted: the retrieval text was
        analyzed and indexed by the server when the document was written.
        """
        with self._store.client() as client:
            binding = self._store.verify_keyword_index(client, collection_name)
            if binding is None:
                raise IndexMissingError(
                    collection_name,
                    "the bound collection disappeared during the query",
                )
            hits = self._store.sparse_search(
                client,
                collection_name,
                query_text=sparse_query,
                filter_expr=filter_expr,
                limit=top_k,
            )

        return self._process_hits(
            hits, score_threshold, score_mapper=keyword_relevance_score
        )

    @staticmethod
    def _resolve_score_threshold(retrieval_setting: Dict[str, Any]) -> float:
        configured_threshold = retrieval_setting.get("score_threshold")
        if configured_threshold is None:
            return DEFAULT_SCORE_THRESHOLD
        return float(configured_threshold)

    @staticmethod
    def _scope_doc_refs(scope: Optional[RetrievalScope]) -> Optional[List[str]]:
        if not scope or not scope.document_ids:
            return None
        return [str(document_id) for document_id in scope.document_ids]

    def _process_hits(
        self,
        hits: Sequence[Dict[str, Any]],
        score_threshold: float,
        *,
        score_mapper: Optional[Callable[[float], float]] = None,
    ) -> Dict:
        records = []
        for hit in hits:
            raw_score = float(hit.get("__score__", 0.0))
            score = score_mapper(raw_score) if score_mapper else raw_score
            if score < score_threshold:
                continue
            metadata = self._row_metadata(hit)
            records.append(
                {
                    "content": hit.get(DISPLAY_TEXT_FIELD)
                    or metadata.get(DISPLAY_TEXT_METADATA_KEY)
                    or "",
                    "score": score,
                    "title": hit.get(SOURCE_FILE_FIELD)
                    or metadata.get("source_file", ""),
                    "metadata": metadata,
                }
            )
        return {"records": records}

    def _row_metadata(self, hit: Dict[str, Any]) -> Dict[str, Any]:
        raw = hit.get(METADATA_FIELD)
        if raw is None:
            metadata: Dict[str, Any] = {}
        elif isinstance(raw, dict):
            metadata = dict(raw)
        else:
            raise StorageBackendError(
                "Stored Milvus metadata is not a JSON object.",
                details={"row_id": hit.get(ID_FIELD)},
            )
        for field in CHUNK_FIELDS_FOR_FILTERING:
            if field in hit:
                metadata.setdefault(field, hit[field])
        if RETRIEVAL_TEXT_FIELD in hit:
            metadata.setdefault(RETRIEVAL_TEXT_FIELD, hit[RETRIEVAL_TEXT_FIELD])
        if DISPLAY_TEXT_FIELD in hit:
            metadata.setdefault(DISPLAY_TEXT_FIELD, hit[DISPLAY_TEXT_FIELD])
        return metadata

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Delete one document; a missing document is an idempotent no-op."""
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=[doc_ref],
            published=False,
        )
        deleted_chunks = self._delete_verified(collection_name, filter_expr)
        self.delete_parent_nodes(knowledge_id, doc_ref, **kwargs)
        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_chunks,
            "status": "deleted",
        }

    def _delete_verified(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        require_bound: bool = True,
    ) -> int:
        with self._store.client() as client:
            if not self._store.has_collection(client, collection_name):
                return 0
            if require_bound:
                # The parent sidecar is not part of the retrieval contract.
                self._store.require_bound(client, collection_name)
            deleted = self._store.count_rows(client, collection_name, filter_expr)
            self._store.delete_rows(client, collection_name, filter_expr)
        with self._store.client() as reader:
            remaining = self._store.count_rows(reader, collection_name, filter_expr)
        if remaining:
            raise StorageBackendError(
                f"Milvus delete verification failed: {remaining} rows remain.",
                details={"collection_name": collection_name, "remaining": remaining},
            )
        return deleted

    def delete_knowledge(self, knowledge_id: str, **kwargs) -> Dict:
        """Delete every chunk and parent node of one knowledge base."""
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        parent_collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        scope_filter = build_scope_filter(knowledge_id=knowledge_id, published=False)
        deleted_chunks = self._delete_verified(collection_name, scope_filter)
        deleted_parent_nodes = self._delete_verified(
            parent_collection_name, scope_filter, require_bound=False
        )
        return {
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_chunks,
            "deleted_parent_nodes": deleted_parent_nodes,
            "status": "deleted",
        }

    def drop_knowledge_index(self, knowledge_id: str, **kwargs) -> Dict:
        """Physically drop the backing collection for a dedicated KB strategy."""
        self._ensure_can_drop_physical_index()
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        parent_collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        dropped_parent_collection = False

        with self._store.client() as client:
            collection_exists = self._store.has_collection(client, collection_name)
            if collection_exists:
                self._store.require_bound(client, collection_name)
            parent_exists = self._store.has_collection(client, parent_collection_name)
            if collection_exists:
                client.drop_collection(collection_name=collection_name)
            if parent_exists:
                client.drop_collection(collection_name=parent_collection_name)
                dropped_parent_collection = True
            self._drop_binding(client, collection_name)

        return {
            "knowledge_id": knowledge_id,
            "collection_name": collection_name,
            "dropped_parent_collection": dropped_parent_collection,
            "status": "dropped",
        }

    def _drop_binding(self, client: MilvusClient, collection_name: str) -> None:
        from knowledge_engine.storage.milvus_native import INDEX_BINDING_COLLECTION

        if not client.has_collection(INDEX_BINDING_COLLECTION):
            return
        client.delete(
            collection_name=INDEX_BINDING_COLLECTION,
            filter=(f'collection_name == "{sanitize_filter_value(collection_name)}"'),
        )
        client.flush(INDEX_BINDING_COLLECTION)

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Read the published chunks of one document in stable order."""
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=[doc_ref],
        )
        rows = self._read_rows(collection_name, filter_expr, limit=MAX_QUERY_LIMIT)

        if not rows:
            raise ValueError(f"Document {doc_ref} not found")

        chunks = [
            {
                "chunk_index": int(row.get(CHUNK_INDEX_FIELD) or 0),
                "content": row.get(DISPLAY_TEXT_FIELD) or "",
                "metadata": self._row_metadata(row),
            }
            for row in rows
        ]
        chunks.sort(key=lambda chunk: chunk["chunk_index"])
        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "source_file": rows[0].get(SOURCE_FILE_FIELD),
            "chunk_count": len(chunks),
            "chunks": chunks,
        }

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """Aggregate published chunks into a page of documents."""
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(knowledge_id=knowledge_id)
        rows = self._read_rows(
            collection_name,
            filter_expr,
            output_fields=[
                DOC_REF_FIELD,
                SOURCE_FILE_FIELD,
                CREATED_AT_FIELD,
                CHUNK_INDEX_FIELD,
            ],
            limit=MAX_QUERY_LIMIT,
        )

        if len(rows) >= MAX_QUERY_LIMIT:
            logger.warning(
                "[Milvus] Knowledge base %s has >= %d chunks; document listing "
                "may be incomplete.",
                knowledge_id,
                MAX_QUERY_LIMIT,
            )

        documents: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            doc_ref = row.get(DOC_REF_FIELD)
            if not doc_ref:
                continue
            document = documents.setdefault(
                doc_ref,
                {
                    "doc_ref": doc_ref,
                    "source_file": row.get(SOURCE_FILE_FIELD),
                    "chunk_count": 0,
                    "created_at": row.get(CREATED_AT_FIELD),
                },
            )
            document["chunk_count"] += 1

        ordered = sorted(
            documents.values(),
            key=lambda document: document.get("created_at") or "",
            reverse=True,
        )
        start = (page - 1) * page_size
        return {
            "documents": ordered[start : start + page_size],
            "total": len(ordered),
            "page": page,
            "page_size": page_size,
            "knowledge_id": knowledge_id,
        }

    def test_connection(self) -> bool:
        """Report whether the configured Milvus service is reachable."""
        try:
            with self._store.client() as client:
                client.list_collections()
            return True
        except Exception:
            logger.warning("[Milvus] Connection test failed", exc_info=True)
            return False

    def get_all_chunks(
        self,
        knowledge_id: str,
        max_chunks: int = MAX_QUERY_LIMIT,
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Read published chunks for direct injection in stable order."""
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(knowledge_id=knowledge_id)
        rows = self._read_rows(collection_name, filter_expr, limit=max_chunks)

        chunks = [
            {
                "content": row.get(DISPLAY_TEXT_FIELD) or "",
                "title": row.get(SOURCE_FILE_FIELD) or "",
                "chunk_id": int(row.get(CHUNK_INDEX_FIELD) or 0),
                "doc_ref": row.get(DOC_REF_FIELD) or "",
                "metadata": self._row_metadata(row),
            }
            for row in rows
        ]
        chunks.sort(key=lambda chunk: (chunk["doc_ref"], chunk["chunk_id"]))
        filtered = filter_chunk_records(chunks, metadata_condition)
        return filtered[:max_chunks]

    def _read_rows(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        limit: int,
        output_fields: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Read published rows without ever creating or adopting a collection."""
        with self._store.client() as client:
            if self._index_is_absent(client, collection_name):
                return []
            return self._store.query_rows(
                client,
                collection_name,
                filter_expr,
                output_fields=output_fields,
                limit=limit,
            )

    def _index_is_absent(self, client: MilvusClient, collection_name: str) -> bool:
        """Distinguish a never-indexed knowledge base from a lost index.

        No stored contract and no collection means the knowledge base was
        never indexed, which is a valid empty result. A stored contract whose
        collection is gone is a service fault and must not degrade into empty.

        A contract an older schema wrote is also a fault: the current code can
        neither read its columns nor serve its capabilities, and answering with
        whatever the old layout happens to contain would hide that. Only an
        explicit operator rebuild moves such a collection forward.
        """
        binding = self._store.read_binding(client, collection_name)
        exists = self._store.has_collection(client, collection_name)
        if binding is None and not exists:
            logger.info(
                "[Milvus] Query on never-indexed knowledge base returns empty: %s",
                collection_name,
            )
            return True
        if binding is not None and not exists:
            raise IndexMissingError(
                collection_name,
                "a confirmed index contract exists but its collection is gone",
            )
        bound = self._store.require_bound(client, collection_name)
        if bound is not None and bound.schema_version != SCHEMA_VERSION:
            raise IndexContractIncompatibleError(
                collection_name,
                "the stored index contract was written by an older schema",
                details={
                    "bound_schema_version": bound.schema_version,
                    "schema_version": SCHEMA_VERSION,
                },
            )
        return False

    def delete_parent_nodes(self, knowledge_id: str, doc_ref: str, **kwargs) -> int:
        return self._parent_store.delete(knowledge_id, doc_ref, **kwargs)

    def save_parent_nodes(
        self,
        knowledge_id: str,
        parent_nodes: List[BaseNode],
        **kwargs,
    ) -> Dict[str, Any]:
        return self._parent_store.save(knowledge_id, parent_nodes, **kwargs)

    def get_parent_nodes(
        self,
        knowledge_id: str,
        parent_node_ids: List[str],
        **kwargs,
    ) -> Dict[str, Dict[str, Any]]:
        return self._parent_store.get(knowledge_id, parent_node_ids, **kwargs)


def _json_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce chunk metadata into the JSON types the Milvus column accepts."""
    return json.loads(json.dumps(metadata, ensure_ascii=False, default=str))
