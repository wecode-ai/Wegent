from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.knowledge.index_runtime import (
    KnowledgeBaseIndexInfo,
    get_kb_index_info,
    get_kb_index_info_by_record,
)
from app.services.knowledge.retrieval_resource_resolver import (
    resolve_embedding_model_resource,
    resolve_retriever_resource,
)
from app.services.rag.runtime_specs import (
    ConnectionTestRuntimeSpec,
    DeleteRuntimeSpec,
    DirectInjectionBudget,
    DropKnowledgeIndexRuntimeSpec,
    IndexRuntimeSpec,
    IndexSource,
    ListChunksRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
    QueryKnowledgeBaseRuntimeConfig,
    QueryRuntimeSpec,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from knowledge_engine.embedding.capabilities import (
    normalize_additional_input_modalities,
)
from shared.db.capability_reference import resolve_model_kind
from shared.knowledge_module import (
    EMBEDDING_RESOURCE_CATEGORY,
    MODEL_RESOURCE_KIND,
    RETRIEVER_RESOURCE_KIND,
)
from shared.models import (
    RemoteAuthorizedRetrievalResources,
    RemoteRetrievalResourceRef,
    RetrievalScope,
    SearchHints,
)
from shared.utils.crypto import decrypt_api_key
from shared.utils.placeholder import process_custom_headers_placeholders


@dataclass(frozen=True)
class _QueryResourceReferences:
    """The retriever and embedding references one knowledge base executes."""

    retriever_name: str
    retriever_namespace: str
    embedding_model_name: str
    embedding_model_namespace: str

    def authorized_entry(
        self,
        *,
        knowledge_base_id: int,
        index_owner_user_id: int,
        explicit_selection: bool = False,
    ) -> RemoteAuthorizedRetrievalResources:
        """Bundle the references into the authorized-resources protocol entry."""
        retriever, embedding_model = self._resource_refs()
        return RemoteAuthorizedRetrievalResources(
            knowledge_base_id=knowledge_base_id,
            index_owner_user_id=index_owner_user_id,
            retriever=retriever,
            embedding_model=embedding_model,
            explicit_selection=explicit_selection,
        )

    def _resource_refs(
        self,
    ) -> tuple[RemoteRetrievalResourceRef, RemoteRetrievalResourceRef]:
        """Return the retriever and embedding references this spec executes."""
        return (
            RemoteRetrievalResourceRef(
                kind=RETRIEVER_RESOURCE_KIND,
                name=self.retriever_name,
                namespace=self.retriever_namespace,
            ),
            RemoteRetrievalResourceRef(
                kind=MODEL_RESOURCE_KIND,
                name=self.embedding_model_name,
                namespace=self.embedding_model_namespace,
            ),
        )


class RagRuntimeResolver:
    def build_index_runtime_spec(
        self,
        *,
        db: Session,
        knowledge_base_id: str,
        attachment_id: int,
        retriever_name: str,
        retriever_namespace: str,
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        user_name: str,
        document_id: int | None,
        splitter_config_dict: dict | None,
        kb_index_info: KnowledgeBaseIndexInfo | None = None,
        resolve_execution_configs: bool = True,
    ) -> IndexRuntimeSpec:
        """Build the index spec one gateway executes.

        ``resolve_execution_configs`` is set from the gateway the caller will
        execute through: the local data plane consumes the fully resolved
        retriever and embedding configuration, while the remote gateway only
        sends the authorized references and leaves configuration to the runtime.
        """
        try:
            parsed_knowledge_base_id = int(knowledge_base_id)
        except ValueError as exc:
            raise ValueError("knowledge_base_id must be an integer") from exc

        kb_info = kb_index_info or get_kb_index_info(
            db=db,
            knowledge_base_id=knowledge_base_id,
            current_user_id=user_id,
        )
        authorized_resources = self._authorized_entry(
            db=db,
            references=_QueryResourceReferences(
                retriever_name=retriever_name,
                retriever_namespace=retriever_namespace,
                embedding_model_name=embedding_model_name,
                embedding_model_namespace=embedding_model_namespace,
            ),
            knowledge_base_id=parsed_knowledge_base_id,
            index_owner_user_id=kb_info.index_owner_user_id,
        )
        retriever_config = None
        embedding_model_config = None
        if resolve_execution_configs:
            retriever_config = self._build_resolved_retriever_config(
                db=db,
                user_id=kb_info.index_owner_user_id,
                name=retriever_name,
                namespace=retriever_namespace,
            )
            embedding_model_config = self._build_resolved_embedding_model_config(
                db=db,
                user_id=kb_info.index_owner_user_id,
                model_name=embedding_model_name,
                model_namespace=embedding_model_namespace,
                user_name=user_name,
            )
        return IndexRuntimeSpec(
            knowledge_base_id=parsed_knowledge_base_id,
            document_id=document_id,
            index_owner_user_id=kb_info.index_owner_user_id,
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_model_namespace,
            authorized_resources=authorized_resources,
            source=IndexSource(source_type="attachment", attachment_id=attachment_id),
            retriever_config=retriever_config,
            embedding_model_config=embedding_model_config,
            splitter_config=splitter_config_dict,
            user_name=user_name,
        )

    def build_query_runtime_spec(
        self,
        *,
        db: Session | None = None,
        knowledge_base_ids: list[int],
        query: str,
        max_results: int,
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"],
        scope: RetrievalScope | None = None,
        document_ids: list[int] | None = None,
        metadata_condition: dict | None = None,
        restricted_mode: bool = False,
        user_id: int | None = None,
        user_name: str | None = None,
        task_id: int | None = None,
        enabled_index_families: list[str] | None = None,
        retrieval_policy: str = "chunk_only",
        context_window: int | None = None,
        used_context_tokens: int = 0,
        reserved_output_tokens: int = 4096,
        context_buffer_ratio: float = 0.1,
        max_direct_chunks: int = 500,
        search_hints: SearchHints | None = None,
        knowledge_base_configs: list[QueryKnowledgeBaseRuntimeConfig] | None = None,
        authorized_resources: list[RemoteAuthorizedRetrievalResources] | None = None,
    ) -> QueryRuntimeSpec:
        direct_injection_budget = None
        if context_window is not None:
            direct_injection_budget = DirectInjectionBudget(
                context_window=context_window,
                used_context_tokens=used_context_tokens,
                reserved_output_tokens=reserved_output_tokens,
                context_buffer_ratio=context_buffer_ratio,
                max_direct_chunks=max_direct_chunks,
            )

        resolved_knowledge_base_configs = (
            [] if knowledge_base_configs is None else knowledge_base_configs
        )
        resolved_authorized_resources = (
            [] if authorized_resources is None else authorized_resources
        )
        if (
            db is not None
            and route_mode == "rag_retrieval"
            and authorized_resources is None
        ):
            resolved_authorized_resources = self.build_query_authorized_resources(
                db=db,
                knowledge_base_ids=knowledge_base_ids,
                read_user_id=user_id,
                task_id=task_id,
            )

        return QueryRuntimeSpec(
            knowledge_base_ids=knowledge_base_ids,
            query=query,
            search_hints=search_hints,
            max_results=max_results,
            route_mode=route_mode,
            scope=scope
            or (RetrievalScope(document_ids=document_ids) if document_ids else None),
            metadata_condition=metadata_condition,
            restricted_mode=restricted_mode,
            user_id=user_id,
            user_name=user_name,
            authorized_resources=resolved_authorized_resources,
            knowledge_base_configs=resolved_knowledge_base_configs,
            enabled_index_families=enabled_index_families or ["chunk_vector"],
            retrieval_policy=retrieval_policy,
            direct_injection_budget=direct_injection_budget,
        )

    def build_public_query_runtime_spec(
        self,
        *,
        db: Session,
        knowledge_base_id: int,
        query: str,
        max_results: int,
        retriever_name: str,
        retriever_namespace: str,
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        user_name: str | None,
        score_threshold: float,
        retrieval_mode: str,
        vector_weight: float | None = None,
        keyword_weight: float | None = None,
        metadata_condition: dict | None = None,
        search_hints: SearchHints | None = None,
    ) -> QueryRuntimeSpec:
        from app.services.knowledge.knowledge_service import KnowledgeService

        kb, has_access = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
        )
        if kb is None or not has_access:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} not found or access denied"
            )

        kb_info = get_kb_index_info_by_record(
            db=db,
            knowledge_base=kb,
            current_user_id=user_id,
        )

        references = _QueryResourceReferences(
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_model_namespace,
        )
        authorized_entry = self._authorized_entry(
            db=db,
            references=references,
            knowledge_base_id=knowledge_base_id,
            index_owner_user_id=kb_info.index_owner_user_id,
            explicit_selection=True,
        )

        return QueryRuntimeSpec(
            knowledge_base_ids=[knowledge_base_id],
            query=query,
            search_hints=search_hints,
            max_results=max_results,
            route_mode="rag_retrieval",
            metadata_condition=metadata_condition,
            user_id=user_id,
            user_name=user_name,
            knowledge_base_retrieval_overrides=[
                {
                    "knowledge_base_id": knowledge_base_id,
                    "retrieval_config": RuntimeRetrievalConfig(
                        top_k=max_results,
                        score_threshold=score_threshold,
                        retrieval_mode=retrieval_mode,
                        vector_weight=vector_weight,
                        keyword_weight=keyword_weight,
                    ),
                }
            ],
            authorized_resources=[authorized_entry],
        )

    def build_query_knowledge_base_configs(
        self,
        *,
        db: Session,
        knowledge_base_ids: list[int],
        current_user_id: int | None = None,
        user_name: str | None,
    ) -> list[QueryKnowledgeBaseRuntimeConfig]:
        return self._build_query_knowledge_base_configs(
            db=db,
            knowledge_base_ids=knowledge_base_ids,
            current_user_id=current_user_id,
            user_name=user_name,
        )

    def build_query_authorized_resources(
        self,
        *,
        db: Session,
        knowledge_base_ids: list[int],
        read_user_id: int | None = None,
        task_id: int | None = None,
    ) -> list[RemoteAuthorizedRetrievalResources]:
        """Authorize the retrieval resources each knowledge base would execute.

        Two separate subjects are checked before anything leaves Backend: the
        caller must be able to read each knowledge base, using the existing
        task-scoped read rule, and the knowledge base owner must be able to use
        the configured retriever and embedding model. Backend then sends only
        these references; the runtime loads just them instead of widening the
        lookup.
        """
        knowledge_base_records = []
        for knowledge_base_id in knowledge_base_ids:
            kb = self._get_knowledge_base_record(
                db=db, knowledge_base_id=knowledge_base_id
            )
            if kb is None:
                raise ValueError(f"Knowledge base {knowledge_base_id} not found")
            knowledge_base_records.append(kb)

        return self.build_query_authorized_resources_from_records(
            db=db,
            knowledge_base_records=knowledge_base_records,
            read_user_id=read_user_id,
            task_id=task_id,
        )

    def build_query_authorized_resources_from_records(
        self,
        *,
        db: Session,
        knowledge_base_records: list[Kind],
        read_user_id: int | None = None,
        task_id: int | None = None,
    ) -> list[RemoteAuthorizedRetrievalResources]:
        authorized: list[RemoteAuthorizedRetrievalResources] = []
        for kb in knowledge_base_records:
            self._require_knowledge_read_access(
                db=db,
                knowledge_base=kb,
                read_user_id=read_user_id,
                task_id=task_id,
            )
            references = self._read_query_resource_references(
                knowledge_base_id=kb.id,
                retrieval_config=self._read_retrieval_config(kb),
            )
            entry = self._authorized_entry(
                db=db,
                references=references,
                knowledge_base_id=kb.id,
                index_owner_user_id=kb.user_id,
            )
            authorized.append(entry)
        return authorized

    @staticmethod
    def _require_knowledge_read_access(
        *,
        db: Session,
        knowledge_base: Kind,
        read_user_id: int | None,
        task_id: int | None,
    ) -> None:
        """Reject the query unless the caller may read this knowledge base.

        The caller identity is resolved with the same task-scoped rule used by
        the other product entries, so a task-bound knowledge base keeps its
        delegated read semantics instead of requiring the task user to own it.
        """
        from app.services.knowledge.knowledge_service import KnowledgeService

        denied = f"Access denied to knowledge base {knowledge_base.id}"
        if read_user_id is None:
            raise HTTPException(
                status_code=403,
                detail="Knowledge query requires an authenticated reader",
            )
        reader = KnowledgeService.resolve_read_user_for_knowledge_base(
            db,
            user_id=read_user_id,
            task_id=task_id,
            knowledge_base_id=knowledge_base.id,
        )
        if reader is None:
            raise HTTPException(status_code=403, detail=denied)
        _, has_access = KnowledgeService.get_knowledge_base(
            db,
            knowledge_base.id,
            reader.id,
        )
        if not has_access:
            raise HTTPException(status_code=403, detail=denied)

    @staticmethod
    def _read_retrieval_config(kb: Kind) -> dict[str, Any]:
        return (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}

    @staticmethod
    def _read_query_resource_references(
        *,
        knowledge_base_id: int,
        retrieval_config: dict[str, Any],
    ) -> _QueryResourceReferences:
        retriever_name = retrieval_config.get("retriever_name")
        embedding_config = retrieval_config.get("embedding_config") or {}
        embedding_model_name = embedding_config.get("model_name")
        if not retriever_name:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} has incomplete retrieval "
                "config (missing retriever_name)"
            )
        if not embedding_model_name:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} has incomplete embedding config"
            )
        return _QueryResourceReferences(
            retriever_name=retriever_name,
            retriever_namespace=retrieval_config.get("retriever_namespace", "default"),
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_config.get(
                "model_namespace", "default"
            ),
        )

    def _authorized_entry(
        self,
        *,
        db: Session,
        references: _QueryResourceReferences,
        knowledge_base_id: int,
        index_owner_user_id: int,
        explicit_selection: bool = False,
    ) -> RemoteAuthorizedRetrievalResources:
        """Bundle one operation's references, rejecting ones the owner cannot use.

        Indexing and querying both run retrieval under the knowledge base owner,
        so one owner-scope rule decides which retriever and embedding model may
        leave Backend. Only these references travel in the remote request; the
        runtime loads just them instead of resolving a configuration Backend
        never checked. Indexing never marks an explicit selection, so the stored
        configuration must still name the records.
        """
        entry = references.authorized_entry(
            knowledge_base_id=knowledge_base_id,
            index_owner_user_id=index_owner_user_id,
            explicit_selection=explicit_selection,
        )
        self._authorize_owner_resources(db=db, entry=entry)
        return entry

    def _authorize_owner_resources(
        self,
        *,
        db: Session,
        entry: RemoteAuthorizedRetrievalResources,
    ) -> None:
        """Reject the operation when the owner may not use a configured resource.

        The knowledge base owner -- not the caller -- owns the retriever and
        embedding model, so resolution runs as the owner through the same
        adapter the create path uses. That reuses one authorization rule for
        group membership, referenced records and the embedding category, so a
        knowledge base whose owner lost access fails before any remote request.
        """
        owner_user_id = entry.index_owner_user_id
        retriever = resolve_retriever_resource(
            db,
            user_id=owner_user_id,
            name=entry.retriever.name,
            namespace=entry.retriever.namespace,
        )
        if retriever is None or retriever.kind != RETRIEVER_RESOURCE_KIND:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Retriever {entry.retriever.name!r} is not available to the "
                    "knowledge base owner"
                ),
            )
        embedding = resolve_embedding_model_resource(
            db,
            user_id=owner_user_id,
            name=entry.embedding_model.name,
            namespace=entry.embedding_model.namespace,
        )
        if embedding is None or embedding.category != EMBEDDING_RESOURCE_CATEGORY:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Embedding model {entry.embedding_model.name!r} is not "
                    "available to the knowledge base owner"
                ),
            )

    def build_public_list_chunks_runtime_spec(
        self,
        *,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        user_name: str | None,
        max_chunks: int,
        query: str | None = None,
        metadata_condition: dict | None = None,
    ) -> ListChunksRuntimeSpec:
        from app.services.knowledge.knowledge_service import KnowledgeService

        kb, has_access = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
        )
        if kb is None or not has_access:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} not found or access denied"
            )

        del user_name
        kb_info = get_kb_index_info_by_record(
            db=db,
            knowledge_base=kb,
            current_user_id=user_id,
        )
        return self._build_list_chunks_runtime_spec(
            db=db,
            kb=kb,
            index_owner_user_id=kb_info.index_owner_user_id,
            max_chunks=max_chunks,
            query=query,
            metadata_condition=metadata_condition,
        )

    def _build_list_chunks_runtime_spec(
        self,
        *,
        db: Session,
        kb: Kind,
        index_owner_user_id: int | None,
        max_chunks: int,
        query: str | None,
        metadata_condition: dict | None,
    ) -> ListChunksRuntimeSpec:
        retrieval_config = (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}
        retriever_name = retrieval_config.get("retriever_name")
        retriever_namespace = retrieval_config.get("retriever_namespace", "default")
        if not retriever_name:
            raise ValueError(
                f"Knowledge base {kb.id} has incomplete retrieval config (missing retriever_name)"
            )

        owner_user_id = (
            kb.user_id if index_owner_user_id is None else index_owner_user_id
        )
        return ListChunksRuntimeSpec(
            knowledge_base_id=kb.id,
            index_owner_user_id=owner_user_id,
            retriever_config=self._build_resolved_retriever_config(
                db=db,
                user_id=owner_user_id,
                name=retriever_name,
                namespace=retriever_namespace,
            ),
            max_chunks=max_chunks,
            query=query,
            metadata_condition=metadata_condition,
        )

    def build_delete_runtime_spec(
        self,
        *,
        db: Session,
        knowledge_base_id: int,
        document_ref: str,
        index_owner_user_id: int | None = None,
        enabled_index_families: list[str] | None = None,
    ) -> DeleteRuntimeSpec:
        kb = self._get_knowledge_base_record(db=db, knowledge_base_id=knowledge_base_id)
        if kb is None:
            raise ValueError(f"Knowledge base {knowledge_base_id} not found")

        retrieval_config = (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}
        retriever_name = retrieval_config.get("retriever_name")
        retriever_namespace = retrieval_config.get("retriever_namespace", "default")
        if not retriever_name:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} has incomplete retrieval config (missing retriever_name)"
            )

        runtime_user_id = (
            kb.user_id if index_owner_user_id is None else index_owner_user_id
        )
        return DeleteRuntimeSpec(
            knowledge_base_id=knowledge_base_id,
            document_ref=document_ref,
            index_owner_user_id=runtime_user_id,
            retriever_config=self._build_resolved_retriever_config(
                db=db,
                user_id=runtime_user_id,
                name=retriever_name,
                namespace=retriever_namespace,
            ),
            enabled_index_families=enabled_index_families or ["chunk_vector"],
        )

    def build_public_purge_index_runtime_spec(
        self,
        *,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        user_name: str | None,
    ) -> PurgeKnowledgeRuntimeSpec:
        from app.services.knowledge.knowledge_service import KnowledgeService

        kb, has_access = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
        )
        if kb is None or not has_access:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} not found or access denied"
            )

        return self._build_kb_index_admin_runtime_spec(
            db=db,
            kb=kb,
            current_user_id=user_id,
            user_name=user_name,
            spec_type="purge",
        )

    def build_public_drop_index_runtime_spec(
        self,
        *,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        user_name: str | None,
    ) -> DropKnowledgeIndexRuntimeSpec:
        from app.services.knowledge.knowledge_service import KnowledgeService

        kb, has_access = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
        )
        if kb is None or not has_access:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} not found or access denied"
            )

        return self._build_kb_index_admin_runtime_spec(
            db=db,
            kb=kb,
            current_user_id=user_id,
            user_name=user_name,
            spec_type="drop",
        )

    def _build_query_knowledge_base_configs(
        self,
        *,
        db: Session,
        knowledge_base_ids: list[int],
        current_user_id: int | None = None,
        user_name: str | None,
    ) -> list[QueryKnowledgeBaseRuntimeConfig]:
        knowledge_base_records = []
        for knowledge_base_id in knowledge_base_ids:
            kb = self._get_knowledge_base_record(
                db=db, knowledge_base_id=knowledge_base_id
            )
            if kb is None:
                raise ValueError(f"Knowledge base {knowledge_base_id} not found")
            knowledge_base_records.append(kb)

        return self.build_query_knowledge_base_configs_from_records(
            db=db,
            knowledge_base_records=knowledge_base_records,
            current_user_id=current_user_id,
            user_name=user_name,
        )

    def build_query_knowledge_base_configs_from_records(
        self,
        *,
        db: Session,
        knowledge_base_records: list[Kind],
        current_user_id: int | None = None,
        user_name: str | None = None,
    ) -> list[QueryKnowledgeBaseRuntimeConfig]:
        configs: list[QueryKnowledgeBaseRuntimeConfig] = []
        for kb in knowledge_base_records:
            knowledge_base_id = kb.id

            retrieval_config = (kb.json or {}).get("spec", {}).get(
                "retrievalConfig"
            ) or {}
            retriever_name = retrieval_config.get("retriever_name")
            retriever_namespace = retrieval_config.get("retriever_namespace", "default")
            embedding_config = retrieval_config.get("embedding_config") or {}
            embedding_model_name = embedding_config.get("model_name")
            embedding_model_namespace = embedding_config.get(
                "model_namespace",
                "default",
            )

            if not retriever_name:
                raise ValueError(
                    f"Knowledge base {knowledge_base_id} has incomplete retrieval config (missing retriever_name)"
                )
            if not embedding_model_name:
                raise ValueError(
                    f"Knowledge base {knowledge_base_id} has incomplete embedding config"
                )

            owner_user_id = kb.user_id
            if current_user_id is not None:
                kb_info = get_kb_index_info_by_record(
                    db=db,
                    knowledge_base=kb,
                    current_user_id=current_user_id,
                )
                owner_user_id = kb_info.index_owner_user_id

            retrieval_mode = retrieval_config.get("retrieval_mode", "vector")
            hybrid_weights = retrieval_config.get("hybrid_weights") or {}
            configs.append(
                QueryKnowledgeBaseRuntimeConfig(
                    knowledge_base_id=knowledge_base_id,
                    index_owner_user_id=owner_user_id,
                    retriever_config=self._build_resolved_retriever_config(
                        db=db,
                        user_id=owner_user_id,
                        name=retriever_name,
                        namespace=retriever_namespace,
                    ),
                    embedding_model_config=self._build_resolved_embedding_model_config(
                        db=db,
                        user_id=owner_user_id,
                        model_name=embedding_model_name,
                        model_namespace=embedding_model_namespace,
                        user_name=user_name,
                    ),
                    retrieval_config=RuntimeRetrievalConfig(
                        top_k=retrieval_config.get("top_k", 20),
                        score_threshold=retrieval_config.get("score_threshold", 0.5),
                        retrieval_mode=retrieval_mode,
                        vector_weight=(
                            hybrid_weights.get("vector_weight")
                            if retrieval_mode == "hybrid"
                            else None
                        ),
                        keyword_weight=(
                            hybrid_weights.get("keyword_weight")
                            if retrieval_mode == "hybrid"
                            else None
                        ),
                    ),
                )
            )
        return configs

    def _get_knowledge_base_record(
        self,
        *,
        db: Session,
        knowledge_base_id: int,
    ):
        return (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )

    def _build_kb_index_admin_runtime_spec(
        self,
        *,
        db: Session,
        kb: Kind,
        current_user_id: int,
        user_name: str | None,
        spec_type: Literal["purge", "drop"],
    ) -> PurgeKnowledgeRuntimeSpec | DropKnowledgeIndexRuntimeSpec:
        retrieval_config = (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}
        retriever_name = retrieval_config.get("retriever_name")
        retriever_namespace = retrieval_config.get("retriever_namespace", "default")
        if not retriever_name:
            raise ValueError(
                f"Knowledge base {kb.id} has incomplete retrieval config (missing retriever_name)"
            )

        kb_info = get_kb_index_info_by_record(
            db=db,
            knowledge_base=kb,
            current_user_id=current_user_id,
        )
        resolved_retriever_config = self._build_resolved_retriever_config(
            db=db,
            user_id=kb_info.index_owner_user_id,
            name=retriever_name,
            namespace=retriever_namespace,
        )

        if spec_type == "purge":
            return PurgeKnowledgeRuntimeSpec(
                knowledge_base_id=kb.id,
                index_owner_user_id=kb_info.index_owner_user_id,
                retriever_config=resolved_retriever_config,
            )

        return DropKnowledgeIndexRuntimeSpec(
            knowledge_base_id=kb.id,
            index_owner_user_id=kb_info.index_owner_user_id,
            retriever_config=resolved_retriever_config,
        )

    def _build_resolved_retriever_config(
        self,
        *,
        db: Session,
        user_id: int,
        name: str,
        namespace: str,
    ) -> RuntimeRetrieverConfig:
        retriever = retriever_kinds_service.get_retriever(
            db=db,
            user_id=user_id,
            name=name,
            namespace=namespace,
        )
        if retriever is None:
            raise ValueError(f"Retriever {name} (namespace: {namespace}) not found")

        storage_config = retriever.spec.storageConfig
        return RuntimeRetrieverConfig(
            name=name,
            namespace=namespace,
            storage_config={
                "type": storage_config.type,
                "url": storage_config.url,
                "username": storage_config.username,
                "password": self._decrypt_optional_secret(storage_config.password),
                "apiKey": self._decrypt_optional_secret(storage_config.apiKey),
                "indexStrategy": (
                    storage_config.indexStrategy.model_dump(exclude_none=True)
                    if storage_config.indexStrategy is not None
                    else {"mode": "per_dataset"}
                ),
                "ext": storage_config.ext or {},
            },
        )

    def _build_resolved_embedding_model_config(
        self,
        *,
        db: Session,
        user_id: int,
        model_name: str,
        model_namespace: str,
        user_name: str | None,
    ) -> RuntimeEmbeddingModelConfig:
        model_kind = self._get_model_kind(
            db=db,
            user_id=user_id,
            model_name=model_name,
            model_namespace=model_namespace,
        )
        if model_kind is None:
            raise ValueError(
                f"Embedding model '{model_name}' not found in namespace '{model_namespace}'"
            )

        spec = (model_kind.json or {}).get("spec", {})
        model_config = spec.get("modelConfig", {})
        env = model_config.get("env", {})
        protocol = spec.get("protocol") or env.get("model")
        custom_headers = env.get("custom_headers", {})
        if custom_headers and isinstance(custom_headers, dict):
            custom_headers = process_custom_headers_placeholders(
                custom_headers,
                user_name,
            )

        embedding_config = spec.get("embeddingConfig", {})
        dimensions = embedding_config.get("dimensions") if embedding_config else None
        encoding_format = (
            embedding_config.get("encoding_format") if embedding_config else None
        )
        additional_input_modalities = normalize_additional_input_modalities(
            embedding_config.get("additional_input_modalities")
            if embedding_config
            else None
        )

        return RuntimeEmbeddingModelConfig(
            model_name=model_name,
            model_namespace=model_namespace,
            resolved_config={
                "protocol": protocol,
                "api_key": self._decrypt_optional_secret(env.get("api_key")),
                "base_url": env.get("base_url"),
                "model_id": env.get("model_id"),
                "custom_headers": (
                    custom_headers if isinstance(custom_headers, dict) else {}
                ),
                "dimensions": dimensions,
                "encoding_format": encoding_format,
                "additional_input_modalities": additional_input_modalities,
            },
        )

    def _get_model_kind(
        self,
        *,
        db: Session,
        user_id: int,
        model_name: str,
        model_namespace: str,
    ) -> Kind | None:
        return resolve_model_kind(
            db,
            name=model_name,
            namespace=model_namespace,
            user_id=user_id,
        )

    def _decrypt_optional_secret(self, value: Any) -> Any:
        if not value:
            return value
        try:
            return decrypt_api_key(value)
        except Exception:
            return value
