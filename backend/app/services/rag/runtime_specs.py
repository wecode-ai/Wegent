from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services.knowledge.splitter_config import (
    NormalizedSplitterConfig,
    build_runtime_default_splitter_config,
    normalize_runtime_splitter_config,
)
from shared.models import (
    RemoteKnowledgeBaseRetrievalOverride,
    RetrievalScope,
    SearchHints,
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
    """Index request that crosses the process boundary with references only.

    ``knowledge_runtime`` resolves the retriever and embedding model from the
    knowledge base record and the document id, so the Backend never carries a
    resolved execution config.
    """

    knowledge_base_id: int
    document_id: Optional[int] = None
    index_owner_user_id: int
    retriever_name: str
    retriever_namespace: str
    embedding_model_name: str
    embedding_model_namespace: str
    source: IndexSource
    index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])
    # Retained by contract: splitter normalization is owned by the knowledge
    # ingestion path, and the runtime re-resolves the splitter from the document
    # record. Dropping this field is a separate contract change.
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


QueryKnowledgeBaseRetrievalOverride = RemoteKnowledgeBaseRetrievalOverride


class QueryRuntimeSpec(RuntimeSpecModel):
    knowledge_base_ids: list[int]
    query: str
    search_hints: SearchHints | None = None
    max_results: int = 5
    route_mode: Literal["auto", "direct_injection", "rag_retrieval"] = "auto"
    direct_injection_budget: Optional[DirectInjectionBudget] = None
    scope: Optional[RetrievalScope] = None
    metadata_condition: Optional[dict] = None
    restricted_mode: bool = False
    user_id: Optional[int] = None
    user_name: Optional[str] = None
    knowledge_base_retrieval_overrides: list[QueryKnowledgeBaseRetrievalOverride] = (
        Field(default_factory=list)
    )
    enabled_index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])
    retrieval_policy: RetrievalPolicy = "chunk_only"


class DeleteRuntimeSpec(RuntimeSpecModel):
    """Delete request that carries the document reference, not its config."""

    knowledge_base_id: int
    document_ref: str
    index_owner_user_id: int
    enabled_index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])


class PurgeKnowledgeRuntimeSpec(RuntimeSpecModel):
    knowledge_base_id: int
    index_owner_user_id: int


class DropKnowledgeIndexRuntimeSpec(RuntimeSpecModel):
    knowledge_base_id: int
    index_owner_user_id: int


class ListChunksRuntimeSpec(RuntimeSpecModel):
    knowledge_base_id: int
    index_owner_user_id: int
    max_chunks: int = 10000
    query: Optional[str] = None
    metadata_condition: Optional[dict] = None


DEFAULT_DIRECT_INJECTION_BUDGET = DirectInjectionBudget()
