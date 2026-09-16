# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus storage backend built directly on the official synchronous PyMilvus.

Scope: dense vector write, retrieval and delete for ordinary documents, plus
the server-maintained index contract that binds a collection to its embedding
space, schema and keyword analyzer. Collections are created only by the
explicit index write path; queries, reads and deletes never create resources.

Three retrieval modes are served from one physical collection: ``vector`` uses
the stored dense vectors with their raw COSINE score, ``keyword`` uses the
server-side BM25 sparse field built over the analyzed retrieval text so it
never asks the embedding provider for a query vector, and ``hybrid`` fuses
both routes with the configured vector/keyword weights. Every mode applies the
same knowledge base, document and metadata filter inside the database before
the ``top_k`` cut. The embedding space contract makes a same-dimension model
swap an explicit failure rather than a silent quality regression.
"""

import json
import logging
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
from knowledge_engine.storage.milvus_cleanup import MilvusCleanup
from knowledge_engine.storage.milvus_filters import compile_metadata_conditions
from knowledge_engine.storage.milvus_hybrid import (
    fuse_hybrid_hits,
    keyword_relevance_score,
    resolve_hybrid_weights,
)
from knowledge_engine.storage.milvus_native import (
    ATTEMPT_ID_FIELD,
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
    MilvusIndexBinding,
    build_scope_filter,
    contract_token_field,
    node_row_id,
    sanitize_filter_value,
)
from knowledge_engine.storage.milvus_parent_store import MilvusParentStore
from knowledge_engine.storage.milvus_rows import (
    MAX_READ_LIMIT,
    MilvusRowReader,
    row_metadata,
)
from shared.models import RetrievalScope

logger = logging.getLogger(__name__)

DEFAULT_TOP_K = 20
DEFAULT_SCORE_THRESHOLD = 0.7
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_ATTEMPT_PREFIX = "gen"


class MilvusBackend(BaseStorageBackend):
    """Dense Milvus storage backend using the official synchronous SDK."""

    SUPPORTED_RETRIEVAL_METHODS: ClassVar[List[str]] = ["vector", "keyword", "hybrid"]
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
        self._reader = MilvusRowReader(
            store_for=lambda: self._store,
            collection_name_for=self.get_index_name,
            missing_index_for=self._index_is_absent,
        )
        self._cleanup = MilvusCleanup(
            store_for=lambda: self._store,
            collection_name_for=self.get_index_name,
            parent_collection_name_for=self.get_parent_store_name,
            # Resolved per call so the storage interface stays the seam a
            # caller (or a test) can replace, not the sidecar behind it.
            parent_delete=lambda knowledge_id, doc_ref, **kwargs: (
                self.delete_parent_nodes(knowledge_id, doc_ref, **kwargs)
            ),
            ensure_can_drop_physical_index=self._ensure_can_drop_physical_index,
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
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
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
        knowledge_id: str,
        doc_ref: str,
        dimension: int,
        embedding_space: str,
        execution_filter: str,
    ) -> None:
        """Create the index if needed and stage every row unpublished.

        A rewrite drops whatever this document stored before it stages the new
        rows, so the version a caller reads is always one version of one
        document. ``MilvusCleanup.clear_document_rows`` owns why that is
        required, which scope it honours and why the index contract is
        confirmed by ``ensure_index`` first.
        """
        with self._store.client() as client:
            self._store.ensure_index(
                client,
                collection_name,
                dimension=dimension,
                embedding_space=embedding_space,
            )
        self._cleanup.clear_document_rows(
            collection_name,
            knowledge_id,
            doc_ref,
            require_bound=False,
            flush=False,
        )
        with self._store.client() as client:
            self._store.upsert_rows(
                client, collection_name, self._with_publication(rows, published=False)
            )
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

        Neither this write nor the staged one waits for a server-side flush.
        The check below proves what publication promises - a separate client
        with Strong consistency sees the rows - but not that the segment is
        sealed, its index built, or the rows durable: Milvus persists in the
        background, so a crash before that flush can lose rows this write
        already reported as published. The Elasticsearch backend issues no
        per-document flush either, and the parity spec asks for nothing
        stronger.
        """
        try:
            with self._store.client() as client:
                self._store.upsert_rows(
                    client,
                    collection_name,
                    self._with_publication(rows, published=True),
                )
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
        ``s / (1 + s)`` mapping. ``hybrid`` fuses both branches with the
        normalized vector/keyword weights. Every mode applies the same
        knowledge base, document and metadata filters inside the database
        before ``top_k``, and compares the resulting score with ``>=`` against
        ``score_threshold``. The score each mode reports is the score the
        threshold compares, so a caller can reason about a returned record
        from its score alone.
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

        # Resolve the weights before any storage call so an invalid request
        # fails without touching the index or the embedding provider.
        vector_weight, keyword_weight = (
            resolve_hybrid_weights(retrieval_setting)
            if retrieval_mode == "hybrid"
            else (None, None)
        )

        # The contract is read once for the whole request and reused by the
        # mode that answers. An empty knowledge base answers empty without
        # calling the embedding provider: only a real index justifies a
        # provider request.
        with self._store.client() as client:
            binding = self._read_bound_index(client, collection_name)
        if binding is None:
            return {"records": []}

        # A zero-weight endpoint is not a hybrid request: it runs the surviving
        # branch alone, so the keyword-only endpoint never builds a query
        # vector and the vector-only endpoint never pays for BM25 analysis.
        if retrieval_mode == "hybrid" and keyword_weight == 0.0:
            retrieval_mode = "vector"
        elif retrieval_mode == "hybrid" and vector_weight == 0.0:
            retrieval_mode = "keyword"

        if retrieval_mode == "keyword":
            return self._keyword_retrieve(
                binding=binding,
                collection_name=collection_name,
                sparse_query=resolved_queries.sparse_query,
                filter_expr=filter_expr,
                top_k=top_k,
                score_threshold=score_threshold,
            )

        if retrieval_mode == "hybrid":
            return self._hybrid_retrieve(
                binding=binding,
                collection_name=collection_name,
                dense_query=resolved_queries.dense_query,
                sparse_query=resolved_queries.sparse_query,
                embed_model=embed_model,
                filter_expr=filter_expr,
                top_k=top_k,
                score_threshold=score_threshold,
                vector_weight=vector_weight,
                keyword_weight=keyword_weight,
            )

        query_vector = prepare_query_vector(embed_model, resolved_queries.dense_query)

        hits = self._dense_search(
            binding=binding,
            collection_name=collection_name,
            query_vector=query_vector,
            embed_model=embed_model,
            filter_expr=filter_expr,
            top_k=top_k,
        )

        return self._process_hits(hits, score_threshold)

    def _dense_search(
        self,
        *,
        binding: MilvusIndexBinding,
        collection_name: str,
        query_vector: Sequence[float],
        embed_model,
        filter_expr: str,
        top_k: int,
    ) -> List[Dict[str, Any]]:
        """Verify the request's contract and run one dense search inside it."""
        with self._store.client() as client:
            self._require_bound_index(
                client,
                collection_name,
                binding=binding,
                dimension=len(query_vector),
                embedding_space=compute_embedding_space(embed_model),
            )
            return self._store.search(
                client,
                collection_name,
                query_vector=query_vector,
                filter_expr=filter_expr,
                limit=top_k,
            )

    def _require_bound_index(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        binding: MilvusIndexBinding,
        dimension: int,
        embedding_space: str,
    ) -> None:
        """Verify the request's contract still serves the requested space."""
        self._require_live_collection(client, collection_name)
        self._store.verify_bound_contract(
            client,
            collection_name,
            binding,
            dimension=dimension,
            embedding_space=embedding_space,
        )

    def _require_live_collection(
        self, client: MilvusClient, collection_name: str
    ) -> None:
        """Fail when the collection confirmed for this request is gone."""
        if not self._store.has_collection(client, collection_name):
            raise IndexMissingError(
                collection_name,
                "the bound collection disappeared during the query",
            )

    def _hybrid_retrieve(
        self,
        *,
        binding: MilvusIndexBinding,
        collection_name: str,
        dense_query: str,
        sparse_query: str,
        embed_model,
        filter_expr: str,
        top_k: int,
        score_threshold: float,
        vector_weight: float,
        keyword_weight: float,
    ) -> Dict:
        """Fuse the dense and keyword routes over one shared scope.

        Both routes are requested with the same knowledge base, document,
        metadata and publication filter, so hybrid never widens what the
        caller may read. ``milvus_hybrid`` owns the scoring contract and why
        the fusion is computed here instead of by the server-side ranker.
        """
        query_vector = prepare_query_vector(embed_model, dense_query)
        with self._store.client() as client:
            self._require_bound_index(
                client,
                collection_name,
                binding=binding,
                dimension=len(query_vector),
                embedding_space=compute_embedding_space(embed_model),
            )
            dense_hits = self._store.search(
                client,
                collection_name,
                query_vector=query_vector,
                filter_expr=filter_expr,
                limit=top_k,
            )
            keyword_hits = self._store.sparse_search(
                client,
                collection_name,
                query_text=sparse_query,
                filter_expr=filter_expr,
                limit=top_k,
            )

        return self._fuse_hybrid_hits(
            dense_hits=dense_hits,
            keyword_hits=keyword_hits,
            vector_weight=vector_weight,
            keyword_weight=keyword_weight,
            score_threshold=score_threshold,
            top_k=top_k,
        )

    def _fuse_hybrid_hits(
        self,
        *,
        dense_hits: Sequence[Dict[str, Any]],
        keyword_hits: Sequence[Dict[str, Any]],
        vector_weight: float,
        keyword_weight: float,
        score_threshold: float,
        top_k: int,
    ) -> Dict:
        """Fuse both routes and cut the fusion on the existing threshold field."""
        hits, scores = fuse_hybrid_hits(
            dense_hits=dense_hits,
            keyword_hits=keyword_hits,
            vector_weight=vector_weight,
            keyword_weight=keyword_weight,
            top_k=top_k,
        )
        return self._process_hits(hits, score_threshold, score_lookup=scores)

    def _keyword_retrieve(
        self,
        *,
        binding: MilvusIndexBinding,
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
            self._require_live_collection(client, collection_name)
            self._store.verify_keyword_binding(collection_name, binding)
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
        score_lookup: Optional[Dict[Any, float]] = None,
    ) -> Dict:
        records = []
        for hit in hits:
            score = self._hit_score(
                hit, score_mapper=score_mapper, score_lookup=score_lookup
            )
            if score < score_threshold:
                continue
            metadata = row_metadata(hit)
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

    @staticmethod
    def _hit_score(
        hit: Dict[str, Any],
        *,
        score_mapper: Optional[Callable[[float], float]],
        score_lookup: Optional[Dict[Any, float]],
    ) -> float:
        """Resolve one hit's reported score from the lookup, mapper or raw value."""
        if score_lookup is not None:
            return float(score_lookup.get(hit.get(ID_FIELD), 0.0))
        raw_score = float(hit.get("__score__", 0.0))
        return score_mapper(raw_score) if score_mapper else raw_score

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Delete one document; a missing document is an idempotent no-op."""
        return self._cleanup.delete_document(knowledge_id, doc_ref, **kwargs)

    def delete_knowledge(self, knowledge_id: str, **kwargs) -> Dict:
        """Delete every chunk and parent node of one knowledge base."""
        return self._cleanup.delete_knowledge(knowledge_id, **kwargs)

    def drop_knowledge_index(self, knowledge_id: str, **kwargs) -> Dict:
        """Physically drop the backing collection for a dedicated KB strategy."""
        return self._cleanup.drop_knowledge_index(knowledge_id, **kwargs)

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Read the published chunks of one document in stable order."""
        return self._reader.get_document(knowledge_id, doc_ref, **kwargs)

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """Aggregate published chunks into a page of documents."""
        return self._reader.list_documents(
            knowledge_id, page=page, page_size=page_size, **kwargs
        )

    def test_connection(self) -> bool:
        """Report whether the configured Milvus service is reachable."""
        try:
            with self._store.client() as client:
                client.list_collections(timeout=self._store.rpc_timeout)
            return True
        except Exception:
            logger.warning("[Milvus] Connection test failed", exc_info=True)
            return False

    def get_all_chunks(
        self,
        knowledge_id: str,
        max_chunks: int = MAX_READ_LIMIT,
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Read published chunks for direct injection in stable order."""
        return self._reader.get_all_chunks(
            knowledge_id,
            max_chunks=max_chunks,
            metadata_condition=metadata_condition,
            **kwargs,
        )

    def _read_bound_index(
        self, client: MilvusClient, collection_name: str
    ) -> Optional[MilvusIndexBinding]:
        """Read this request's index contract, or None when never indexed.

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
        if binding is None:
            if exists:
                raise IndexContractIncompatibleError(
                    collection_name,
                    "the collection has no stored index contract",
                )
            logger.info(
                "[Milvus] Query on never-indexed knowledge base returns empty: %s",
                collection_name,
            )
            return None
        if not exists:
            raise IndexMissingError(
                collection_name,
                "a confirmed index contract exists but its collection is gone",
            )
        if binding.schema_version != SCHEMA_VERSION:
            raise IndexContractIncompatibleError(
                collection_name,
                "the stored index contract was written by an older schema",
                details={
                    "bound_schema_version": binding.schema_version,
                    "schema_version": SCHEMA_VERSION,
                },
            )
        return binding

    def _index_is_absent(self, client: MilvusClient, collection_name: str) -> bool:
        """True when a read may answer empty because the KB was never indexed."""
        return self._read_bound_index(client, collection_name) is None

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
