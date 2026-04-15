from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services.knowledge.splitter_config import (
    NormalizedSplitterConfig,
    build_runtime_default_splitter_config,
    normalize_runtime_splitter_config,
)
from shared.models import (
    RemoteKnowledgeBaseQueryConfig,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)

RetrievalPolicy = Literal[
    "chunk_only",
    "summary_first",
    "summary_then_chunk_expand",
    "hybrid",
]


class RuntimeSpecModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class IndexSource(RuntimeSpecModel):
    source_type: Literal["attachment"]
    attachment_id: int


class DirectInjectionBudget(RuntimeSpecModel):
    context_window: Optional[int] = None
    used_context_tokens: int = 0
    reserved_output_tokens: int = 4096
    context_buffer_ratio: float = 0.1
    max_direct_chunks: int = 500


class IndexRuntimeSpec(RuntimeSpecModel):
    knowledge_base_id: int
    document_id: Optional[int] = None
    index_owner_user_id: int
    retriever_name: str
    retriever_namespace: str
    embedding_model_name: str
    embedding_model_namespace: str
    source: IndexSource
    retriever_config: RuntimeRetrieverConfig | None = None
    embedding_model_config: RuntimeEmbeddingModelConfig | None = None
    index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])
    splitter_config: NormalizedSplitterConfig = Field(
        default_factory=build_runtime_default_splitter_config
    )
    user_name: Optional[str] = None

    @field_validator("splitter_config", mode="before")
    @classmethod
    def normalize_splitter_config_for_runtime(
        cls,
        value: dict | BaseModel | None,
    ) -> NormalizedSplitterConfig:
        return normalize_runtime_splitter_config(value)


QueryKnowledgeBaseRuntimeConfig = RemoteKnowledgeBaseQueryConfig


class QueryRuntimeSpec(RuntimeSpecModel):
    knowledge_base_ids: list[int]
    query: str
    max_results: int = 5
    route_mode: Literal["auto", "direct_injection", "rag_retrieval"] = "auto"
    direct_injection_budget: Optional[DirectInjectionBudget] = None
    document_ids: Optional[list[int]] = None
    metadata_condition: Optional[dict] = None
    restricted_mode: bool = False
    user_id: Optional[int] = None
    user_name: Optional[str] = None
    knowledge_base_configs: list[QueryKnowledgeBaseRuntimeConfig] = Field(
        default_factory=list
    )
    enabled_index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])
    retrieval_policy: RetrievalPolicy = "chunk_only"


class DeleteRuntimeSpec(RuntimeSpecModel):
    knowledge_base_id: int
    document_ref: str
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig
    enabled_index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])


class PurgeKnowledgeRuntimeSpec(RuntimeSpecModel):
    knowledge_base_id: int
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig


class DropKnowledgeIndexRuntimeSpec(RuntimeSpecModel):
    knowledge_base_id: int
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig


class ListChunksRuntimeSpec(RuntimeSpecModel):
    knowledge_base_id: int
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig
    max_chunks: int = 10000
    query: Optional[str] = None
    metadata_condition: Optional[dict] = None


class ConnectionTestRuntimeSpec(RuntimeSpecModel):
    retriever_config: RuntimeRetrieverConfig


DEFAULT_DIRECT_INJECTION_BUDGET = DirectInjectionBudget()
