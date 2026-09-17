# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus storage backend built directly on the official synchronous PyMilvus.

Scope: dense vector write, retrieval and delete for ordinary documents, plus
the index contract each collection declares about itself - the embedding space,
schema and keyword analyzer it was created for. Collections are created only by
the explicit index write path; queries, reads and deletes never create
resources.

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
from dataclasses import dataclass
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
from knowledge_engine.retrieval.search_hints import (
    ResolvedSearchQueries,
    resolve_search_queries,
)
from knowledge_engine.storage.base import (
    DISPLAY_TEXT_METADATA_KEY,
    BaseStorageBackend,
)
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
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
    CHUNK_INDEX_FIELD,
    CREATED_AT_FIELD,
    DENSE_VECTOR_FIELD,
    DISPLAY_TEXT_FIELD,
    DOC_REF_FIELD,
    ID_FIELD,
    KNOWLEDGE_ID_FIELD,
    METADATA_FIELD,
    RETRIEVAL_TEXT_FIELD,
    SCHEMA_VERSION,
    SOURCE_FILE_FIELD,
    MilvusIndexBinding,
    build_scope_filter,
    node_row_id,
)
from knowledge_engine.storage.milvus_parent_store import MilvusParentStore
from knowledge_engine.storage.milvus_rows import (
    MAX_READ_LIMIT,
    MilvusRowReader,
    row_metadata,
)
from knowledge_engine.storage.milvus_store import MilvusDocumentStore
from shared.models import DEFAULT_SCORE_THRESHOLD, RetrievalScope

logger = logging.getLogger(__name__)

DEFAULT_TOP_K = 20
DEFAULT_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class _RetrievalRequest:
    """One ``retrieve()`` call resolved into everything a branch needs."""

    collection_name: str
    retrieval_mode: str
    embed_model: Any
    resolved_queries: ResolvedSearchQueries
    filter_expr: str
    top_k: int
    score_threshold: float
    vector_weight: Optional[float]
    keyword_weight: Optional[float]


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
            parent_scope_filter=self._parent_store.scope_filter,
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
        """Write one document into Milvus with a single write.

        The version stored before this write is removed first, and a failed
        write removes whatever this write left behind, so a caller never reads
        two versions of one document at once.
        """
        materialized = [node for node in nodes if self._node_has_content(node)]
        if not materialized:
            raise EmptyIndexableContentError()

        knowledge_id = chunk_metadata.knowledge_id
        doc_ref = chunk_metadata.doc_ref
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
            )
            for node, vector in zip(materialized, vectors)
        ]

        self._write_rows(
            collection_name,
            rows,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            dimension=dimension,
            embedding_space=embedding_space,
        )

        logger.info(
            "[Milvus] Indexed document: collection=%s, doc_ref=%s, chunks=%d, "
            "dimension=%d",
            collection_name,
            doc_ref,
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

    def _write_rows(
        self,
        collection_name: str,
        rows: List[Dict[str, Any]],
        *,
        knowledge_id: str,
        doc_ref: str,
        dimension: int,
        embedding_space: str,
    ) -> None:
        """Create the index if needed, then replace one document's rows.

        A rewrite drops whatever this document stored before it stages the new
        rows, so the version a caller reads is always one version of one
        document. ``MilvusCleanup.clear_document_rows`` owns why that is
        required, which scope it honours and why the index contract is
        confirmed by ``ensure_index`` first.

        The rows are written once and never published in a second pass, and the
        write returns as soon as the server accepted them. Retrieval reads at
        ``Bounded``, so a read issued in the first ~0.5s after this write can
        miss the document; the parity spec accepts that window instead of
        buying it back with a write-side wait.

        Milvus has no transaction spanning the write, so the failure path is
        explicit: the document's rows are removed again at this write
        boundary. The price of dropping the old row-count check is that a
        server that accepts a write and stores nothing is no longer detected
        here; the parity spec accepts that in exchange for one write.
        """
        with self._store.client() as client:
            self._store.ensure_index(
                client,
                collection_name,
                dimension=dimension,
                embedding_space=embedding_space,
            )
        self._remove_document_rows(collection_name, knowledge_id, doc_ref)
        try:
            with self._store.client() as client:
                self._store.upsert_rows(client, collection_name, rows)
        except Exception as write_error:
            self._drop_failed_write(collection_name, knowledge_id, doc_ref, write_error)

    def _remove_document_rows(
        self, collection_name: str, knowledge_id: str, doc_ref: str
    ) -> int:
        """Remove one document's rows at the write boundary.

        ``require_bound`` is False because this write confirmed the index
        contract of this collection just before. ``flush`` is False because
        the removal is proven with a Strong consistency read and must not seal
        the segment on every rewrite.
        """
        return self._cleanup.clear_document_rows(
            collection_name,
            knowledge_id,
            doc_ref,
            require_bound=False,
            flush=False,
        )

    def _drop_failed_write(
        self,
        collection_name: str,
        knowledge_id: str,
        doc_ref: str,
        write_error: Exception,
    ) -> None:
        """Remove the rows of a failed write, or fail with that cleanup.

        The write path never reports this failure as a success: either the
        original write failure is re-raised, or - when the rows could not be
        removed - a failure that names both is raised, because the document
        may still be readable. That cleanup failure is retryable: re-running
        the write removes the document's rows before it writes them again, so
        the retry converges instead of layering a second version.

        It runs while the caller handles that write failure, so the final bare
        ``raise`` re-raises it - a cleanup that could not prove its removal is
        the only failure this helper raises itself.

        Neither this write nor the one it cleans up waits for a server-side
        flush: Milvus persists in the background, so a crash before its own
        flush can lose rows this write already reported as written. The
        Elasticsearch backend issues no per-document flush either, and the
        parity spec asks for nothing stronger.
        """
        try:
            self._remove_document_rows(collection_name, knowledge_id, doc_ref)
        except Exception as cleanup_error:
            raise StorageBackendError(
                f"Milvus write failed and the rows of document '{doc_ref}' in "
                f"'{collection_name}' could not be removed afterwards; the "
                "document may still be readable. Re-run the same write.",
                details={
                    "collection_name": collection_name,
                    "doc_ref": doc_ref,
                    "write_error": str(write_error),
                    "cleanup_error": str(cleanup_error),
                },
                retryable=True,
            ) from write_error
        raise

    def _node_has_content(self, node: BaseNode) -> bool:
        """A chunk with neither retrieval nor display text is not indexable."""
        retrieval_text = self.get_node_embedding_text(node)
        display_text = self.get_node_display_text(node)
        return bool(retrieval_text.strip() or display_text.strip())

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
    ) -> Dict[str, Any]:
        metadata = dict(node.metadata or {})
        chunk_index = int(metadata.get("chunk_index") or 0)
        return {
            ID_FIELD: node_row_id(
                knowledge_id=knowledge_id,
                doc_ref=doc_ref,
                chunk_index=chunk_index,
            ),
            KNOWLEDGE_ID_FIELD: knowledge_id,
            DOC_REF_FIELD: doc_ref,
            SOURCE_FILE_FIELD: str(metadata.get("source_file") or ""),
            CHUNK_INDEX_FIELD: chunk_index,
            RETRIEVAL_TEXT_FIELD: self.get_node_embedding_text(node),
            DISPLAY_TEXT_FIELD: self.get_node_display_text(node),
            METADATA_FIELD: _json_metadata(metadata),
            CREATED_AT_FIELD: str(metadata.get("created_at") or ""),
            DENSE_VECTOR_FIELD: [float(value) for value in vector],
        }

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
        """Retrieve stored chunks in scope for one retrieval mode.

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
        request = self._resolve_request(
            knowledge_id,
            query,
            embed_model,
            retrieval_setting,
            scope=scope,
            metadata_condition=metadata_condition,
            index_kwargs=kwargs,
        )

        # One request owns exactly one client: the contract read and the
        # answering branch share it, and the context manager still closes it
        # on every exit. Concurrent requests keep independent connections.
        with self._store.client() as client:
            binding = self._read_bound_index(client, request.collection_name)
            if binding is None:
                return {"records": []}
            return self._dispatch(client, binding, request)

    def _resolve_request(
        self,
        knowledge_id: str,
        query: str,
        embed_model,
        retrieval_setting: Dict[str, Any],
        *,
        scope: Optional[RetrievalScope],
        metadata_condition: Optional[Dict[str, Any]],
        index_kwargs: Dict[str, Any],
    ) -> _RetrievalRequest:
        """Validate one request and resolve it before anything is stored."""
        retrieval_mode = str(retrieval_setting.get("retrieval_mode") or "vector")
        if retrieval_mode not in self.SUPPORTED_RETRIEVAL_METHODS:
            raise UnsupportedStorageCapabilityError(
                f"{retrieval_mode} retrieval mode", backend="milvus"
            )
        # Resolve the weights before any storage call so an invalid request
        # fails without touching the index or the embedding provider.
        vector_weight, keyword_weight = (
            resolve_hybrid_weights(retrieval_setting)
            if retrieval_mode == "hybrid"
            else (None, None)
        )
        return _RetrievalRequest(
            collection_name=self.get_index_name(knowledge_id, **index_kwargs),
            retrieval_mode=retrieval_mode,
            embed_model=embed_model,
            resolved_queries=resolve_search_queries(query, retrieval_setting),
            filter_expr=build_scope_filter(
                knowledge_id=knowledge_id,
                doc_refs=self._scope_doc_refs(scope),
                extra_conditions=compile_metadata_conditions(metadata_condition),
            ),
            top_k=int(retrieval_setting.get("top_k") or DEFAULT_TOP_K),
            score_threshold=self._resolve_score_threshold(retrieval_setting),
            vector_weight=vector_weight,
            keyword_weight=keyword_weight,
        )

    def _dispatch(
        self,
        client: MilvusClient,
        binding: MilvusIndexBinding,
        request: _RetrievalRequest,
    ) -> Dict:
        """Answer one resolved request on the client that read its contract.

        The contract is read once per request and reused by the mode that
        answers, so an empty knowledge base answers empty without calling the
        embedding provider: only a real index justifies a provider request.
        """
        retrieval_mode = request.retrieval_mode
        # A zero-weight endpoint is not a hybrid request: it runs the surviving
        # branch alone, so the keyword-only endpoint never builds a query vector
        # and the vector-only endpoint never pays for BM25 analysis.
        if retrieval_mode == "hybrid" and request.keyword_weight == 0.0:
            retrieval_mode = "vector"
        elif retrieval_mode == "hybrid" and request.vector_weight == 0.0:
            retrieval_mode = "keyword"

        if retrieval_mode == "keyword":
            return self._keyword_retrieve(
                client,
                binding=binding,
                collection_name=request.collection_name,
                sparse_query=request.resolved_queries.sparse_query,
                filter_expr=request.filter_expr,
                top_k=request.top_k,
                score_threshold=request.score_threshold,
            )

        if retrieval_mode == "hybrid":
            return self._hybrid_retrieve(
                client,
                binding=binding,
                collection_name=request.collection_name,
                dense_query=request.resolved_queries.dense_query,
                sparse_query=request.resolved_queries.sparse_query,
                embed_model=request.embed_model,
                filter_expr=request.filter_expr,
                top_k=request.top_k,
                score_threshold=request.score_threshold,
                vector_weight=request.vector_weight,
                keyword_weight=request.keyword_weight,
            )

        query_vector = prepare_query_vector(
            request.embed_model, request.resolved_queries.dense_query
        )
        hits = self._dense_search(
            client,
            binding=binding,
            collection_name=request.collection_name,
            query_vector=query_vector,
            embed_model=request.embed_model,
            filter_expr=request.filter_expr,
            top_k=request.top_k,
        )
        return self._process_hits(hits, request.score_threshold)

    def _dense_search(
        self,
        client: MilvusClient,
        *,
        binding: MilvusIndexBinding,
        collection_name: str,
        query_vector: Sequence[float],
        embed_model,
        filter_expr: str,
        top_k: int,
    ) -> List[Dict[str, Any]]:
        """Verify the request's contract and run one dense search on its client."""
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
        self._store.confirm_contract(
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
        client: MilvusClient,
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
        metadata and scope filter, so hybrid never widens what the caller may
        read. ``milvus_hybrid`` owns the scoring contract and why the fusion is
        computed here instead of by the server-side ranker.
        """
        query_vector = prepare_query_vector(embed_model, dense_query)
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
        client: MilvusClient,
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
        """Read the stored chunks of one document in stable order."""
        return self._reader.get_document(knowledge_id, doc_ref, **kwargs)

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """Aggregate stored chunks into a page of documents."""
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
        """Read stored chunks for direct injection in stable order."""
        return self._reader.get_all_chunks(
            knowledge_id,
            max_chunks=max_chunks,
            metadata_condition=metadata_condition,
            **kwargs,
        )

    def _read_bound_index(
        self, client: MilvusClient, collection_name: str
    ) -> Optional[MilvusIndexBinding]:
        """Read the contract the collection itself declares, None if it is absent.

        The contract lives with the collection, so one read answers everything a
        request needs about it. No collection means the knowledge base was never
        indexed, which is a valid empty result: a collection dropped outside the
        product leaves nothing behind either, so it reads the same way - the
        observation limitation the parity spec retains instead of recording the
        index anywhere else.

        A collection that exists without a readable contract, or whose contract
        an older schema wrote, is a fault: the current code can neither read its
        columns nor serve its capabilities, and answering with whatever the
        collection happens to contain would hide that. Only an explicit operator
        rebuild moves such a collection forward.
        """
        binding = self._store.read_contract(client, collection_name)
        if binding is None:
            logger.info(
                "[Milvus] Query on never-indexed knowledge base returns empty: %s",
                collection_name,
            )
            return None
        # The keyword and document paths never compare a request contract, so
        # the version is checked here for every read path: a collection an older
        # schema wrote cannot serve this one.
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
