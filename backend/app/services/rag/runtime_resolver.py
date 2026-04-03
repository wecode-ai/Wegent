from typing import Literal

from sqlalchemy.orm import Session

from app.services.knowledge.index_runtime import (
    KnowledgeBaseIndexInfo,
    get_kb_index_info,
)
from app.services.rag.runtime_specs import (
    DirectInjectionBudget,
    IndexRuntimeSpec,
    IndexSource,
    QueryRuntimeSpec,
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
    ) -> IndexRuntimeSpec:
        try:
            parsed_knowledge_base_id = int(knowledge_base_id)
        except ValueError as exc:
            raise ValueError("knowledge_base_id must be an integer") from exc

        kb_info = kb_index_info or get_kb_index_info(
            db=db,
            knowledge_base_id=knowledge_base_id,
            current_user_id=user_id,
        )
        return IndexRuntimeSpec(
            knowledge_base_id=parsed_knowledge_base_id,
            document_id=document_id,
            index_owner_user_id=kb_info.index_owner_user_id,
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_model_namespace,
            source=IndexSource(source_type="attachment", attachment_id=attachment_id),
            splitter_config=splitter_config_dict,
            user_name=user_name,
        )

    def build_query_runtime_spec(
        self,
        *,
        knowledge_base_ids: list[int],
        query: str,
        max_results: int,
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"],
        document_ids: list[int] | None = None,
        restricted_mode: bool = False,
        user_id: int | None = None,
        user_name: str | None = None,
        context_window: int | None = None,
        used_context_tokens: int = 0,
        reserved_output_tokens: int = 4096,
        context_buffer_ratio: float = 0.1,
        max_direct_chunks: int = 500,
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

        return QueryRuntimeSpec(
            knowledge_base_ids=knowledge_base_ids,
            query=query,
            max_results=max_results,
            route_mode=route_mode,
            document_ids=document_ids,
            restricted_mode=restricted_mode,
            user_id=user_id,
            user_name=user_name,
            direct_injection_budget=direct_injection_budget,
        )
