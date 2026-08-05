# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for knowledge base and document management.
"""

import logging
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.base_role import BaseRole

# Import shared types from kind.py to avoid duplication
from app.schemas.kind import (
    EmbeddingModelRef,
    HybridWeights,
    RetrievalConfig,
    RetrieverRef,
    SummaryModelRef,
)
from app.schemas.knowledge_multimodal import (
    DocumentReindexRequest,
    MultimodalAnalysisFieldsMixin,
    MultimodalAnalysisResponseFieldsMixin,
    MultimodalDocumentPromptMixin,
    multimodal_response_kwargs,
)
from app.schemas.knowledge_search import KnowledgeSearchRequest

# Import SplitterConfig from rag.py to use unified splitter configuration
from app.schemas.rag import SplitterConfig
from app.services.knowledge.splitter_config import normalize_splitter_config

logger = logging.getLogger(__name__)


class DocumentStatus(str, Enum):
    """Document status enumeration."""

    ENABLED = "enabled"
    DISABLED = "disabled"


class DocumentSourceType(str, Enum):
    """Document source type enumeration."""

    FILE = "file"
    TEXT = "text"
    TABLE = "table"
    WEB = "web"
    ATTACHMENT = "attachment"
    # Source file indexed for retrieval rather than a browsable document. Declared so
    # ensure_source_type_enum does not silently coerce it to FILE.
    CODE = "code"


class DocumentIndexStatus(str, Enum):
    """Business status enumeration for document indexing."""

    NOT_INDEXED = "not_indexed"
    QUEUED = "queued"
    PENDING_CONVERSION = "pending_conversion"
    CONVERTING = "converting"
    INDEXING = "indexing"
    SUCCESS = "success"
    FAILED = "failed"


class DocumentProcessingStage(str, Enum):
    """Stage in which document processing failed."""

    DISPATCH = "dispatch"
    CONVERSION = "conversion"
    INDEXING = "indexing"
    SYSTEM = "system"


class DocumentProcessingError(BaseModel):
    """Safe error details for the current document processing generation.

    ``code`` is the stable semantic identifier and the authoritative key for
    client localization. ``message`` is a safe, non-localized fallback for
    older clients, unknown codes, and API consumers without an i18n catalog.
    """

    stage: DocumentProcessingStage
    code: str = Field(min_length=1, max_length=64)
    message: str = Field(min_length=1, max_length=1000)
    retryable: bool = False
    generation: int = Field(ge=0)
    occurred_at: datetime
    provider: Optional[str] = Field(default=None, max_length=64)
    model: Optional[str] = Field(default=None, max_length=128)
    request_id: Optional[str] = Field(default=None, max_length=128)


class ResourceScope(str, Enum):
    """Resource scope for filtering."""

    PERSONAL = "personal"
    GROUP = "group"
    ORGANIZATION = "organization"
    ALL = "all"


class KnowledgeBaseType(str, Enum):
    """What a knowledge base is, stored at ``spec.kbType``.

    ``notebook`` and ``classic`` differ only in the default opening view and can be
    switched freely. ``code_wiki`` is a different thing altogether: it is bound to a
    source repository, generated and maintained by an agent, and published by the
    server rather than edited by hand.

    The three are mutually exclusive, so one field carries all of them. A knowledge
    base may move between ``notebook`` and ``classic``, but **never** into or out of
    ``code_wiki``: doing so would either orphan a repository binding and its version
    history, or produce a code wiki with no repository at all.
    """

    NOTEBOOK = "notebook"
    CLASSIC = "classic"
    CODE_WIKI = "code_wiki"


# ============== Knowledge Base Schemas ==============
# Note: RetrieverRef, EmbeddingModelRef, HybridWeights, RetrievalConfig
# are imported from app.schemas.kind to maintain single source of truth


class InitialMemberCreate(BaseModel):
    """Schema for an initial member when creating a knowledge base."""

    entity_type: str = Field(
        default="user",
        description="Entity type: 'user', 'namespace', or other registered types",
    )
    entity_id: str = Field(
        ...,
        min_length=1,
        description="Entity identifier (user ID or namespace ID)",
    )
    role: BaseRole = Field(
        default=BaseRole.Reporter,
        description="Member role: Maintainer, Developer, Reporter, RestrictedAnalyst",
    )
    entity_display_name: Optional[str] = Field(
        default=None,
        description="Display name snapshot for the entity (e.g., department name, group display name)",
    )


class RetrievalConfigCreate(BaseModel):
    """Partial retrieval configuration accepted during knowledge base creation."""

    retriever_name: Optional[str] = Field(None, description="Retriever name")
    retriever_namespace: str = Field("default", description="Retriever namespace")
    embedding_config: Optional[EmbeddingModelRef] = Field(
        None, description="Embedding model configuration"
    )
    retrieval_mode: str = Field(
        "vector", description="Retrieval mode: 'vector', 'keyword', or 'hybrid'"
    )
    top_k: int = Field(5, ge=1, le=10, description="Number of results to return")
    score_threshold: float = Field(
        0.5, ge=0.0, le=1.0, description="Minimum score threshold"
    )
    hybrid_weights: Optional[HybridWeights] = Field(
        None, description="Hybrid search weights"
    )


class KnowledgeBaseCreate(MultimodalAnalysisFieldsMixin):
    """Schema for creating a knowledge base."""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    namespace: str = Field(default="default", max_length=255)
    direct_access_requirement: Literal["read", "edit"] = Field(
        default="read",
        description="Minimum capability required for direct knowledge base access",
    )
    kb_type: KnowledgeBaseType = Field(
        KnowledgeBaseType.NOTEBOOK,
        description=(
            "'notebook' opens Notebook view by default, 'classic' opens document view. "
            "'code_wiki' is a repository-backed, agent-generated wiki and can only be "
            "created through the dedicated code wiki endpoint."
        ),
    )
    source: Optional[Dict[str, Any]] = Field(
        None,
        description="Source repository a code wiki is generated from (code wikis only)",
    )
    language: Optional[str] = Field(
        None,
        max_length=10,
        description=(
            "Language a code wiki's pages are generated in. None falls back to the "
            "deployment default rather than meaning English."
        ),
    )
    show_generation_task: bool = Field(
        False,
        description=(
            "Whether a code wiki's generation runs appear in the creator's "
            "conversation list. Off by default: a wiki regenerates on its own, so "
            "its runs are work nobody started a conversation to do. The wiki's run "
            "history shows them either way and links to the task, so hiding them "
            "loses nothing. Meaningless for other knowledge base types."
        ),
    )
    retrieval_config: Optional[RetrievalConfigCreate] = Field(
        None, description="Retrieval configuration"
    )
    rag_config_mode: Literal["auto", "disabled"] = Field(
        "auto",
        description="RAG configuration mode: auto-fill or disabled",
    )
    summary_enabled: bool = Field(
        default=False,
        description="Enable automatic summary generation for documents",
    )
    summary_model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference for summary generation. Format: {'name': 'model-name', 'namespace': 'default', 'type': 'public|user|group'}",
    )
    guided_questions: Optional[List[str]] = Field(
        None,
        max_length=3,
        description="Guided questions list (max 3) to show in notebook mode for quick user interaction",
    )
    members: Optional[List[InitialMemberCreate]] = Field(
        None,
        description="Initial members to add to the knowledge base after creation",
    )

    @field_validator("guided_questions")
    @classmethod
    def validate_guided_questions(cls, v):
        """Validate guided questions list."""
        if v is not None:
            if len(v) > 3:
                raise ValueError("Maximum 3 guided questions allowed")
            for i, q in enumerate(v):
                if not q or len(q.strip()) == 0:
                    raise ValueError(f"Guided question at index {i} cannot be empty")
                if len(q) > 200:
                    raise ValueError(
                        f"Guided question at index {i} exceeds 200 characters"
                    )
        return v


class RetrievalConfigUpdate(BaseModel):
    """Schema for updating retrieval configuration (excluding retriever and embedding model)."""

    retrieval_mode: Optional[str] = Field(
        None, description="Retrieval mode: 'vector', 'keyword', or 'hybrid'"
    )
    top_k: Optional[int] = Field(
        None, ge=1, le=10, description="Number of results to return"
    )
    score_threshold: Optional[float] = Field(
        None, ge=0.0, le=1.0, description="Minimum score threshold"
    )
    hybrid_weights: Optional[HybridWeights] = Field(
        None, description="Hybrid search weights"
    )


class KnowledgeBaseUpdate(MultimodalAnalysisFieldsMixin):
    """Schema for updating a knowledge base."""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    direct_access_requirement: Optional[Literal["read", "edit"]] = Field(
        default=None,
        description="Minimum capability required for direct knowledge base access",
    )
    retrieval_config: Optional[RetrievalConfigUpdate] = Field(
        None,
        description="Retrieval configuration update (excludes retriever and embedding model)",
    )
    summary_enabled: Optional[bool] = Field(
        None,
        description="Enable automatic summary generation for documents",
    )
    summary_model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference for summary generation. Format: {'name': 'model-name', 'namespace': 'default', 'type': 'public|user|group'}",
    )
    show_generation_task: Optional[bool] = Field(
        None,
        description=(
            "Whether a code wiki's generation runs appear in the conversation list. "
            "Editable after creation: it is a display preference, not something the "
            "wiki was built with, so a reader who wants to watch a run should not "
            "have to rebuild the wiki to see one."
        ),
    )
    guided_questions: Optional[List[str]] = Field(
        None,
        max_length=3,
        description="Guided questions list (max 3) to show in notebook mode for quick user interaction",
    )

    # Knowledge base tool call limit configuration
    max_calls_per_conversation: Optional[int] = Field(
        None,
        ge=2,
        le=50,
        description="Maximum number of knowledge base tool calls allowed per conversation",
    )
    exempt_calls_before_check: Optional[int] = Field(
        None,
        ge=1,
        description="Number of calls exempt from token checking (must be < max_calls_per_conversation)",
    )

    @model_validator(mode="after")
    def validate_call_limits(self):
        """Validate that exempt_calls_before_check < max_calls_per_conversation"""
        if (
            self.exempt_calls_before_check is not None
            and self.max_calls_per_conversation is not None
        ):
            if self.exempt_calls_before_check >= self.max_calls_per_conversation:
                raise ValueError(
                    "exempt_calls_before_check must be less than max_calls_per_conversation"
                )
        return self

    @field_validator("guided_questions")
    @classmethod
    def validate_guided_questions(cls, v):
        """Validate guided questions list."""
        if v is not None:
            if len(v) > 3:
                raise ValueError("Maximum 3 guided questions allowed")
            for i, q in enumerate(v):
                if not q or len(q.strip()) == 0:
                    raise ValueError(f"Guided question at index {i} cannot be empty")
                if len(q) > 200:
                    raise ValueError(
                        f"Guided question at index {i} exceeds 200 characters"
                    )
        return v


class CodeWikiCreate(KnowledgeBaseCreate):
    """Request to create a code wiki bound to a source repository.

    **Inherits every field of ``KnowledgeBaseCreate``** rather than restating the ones
    a code wiki happens to need. A code wiki is an ordinary knowledge base with a
    repository attached, so retrieval, summary, guided questions and call limits all
    apply to it — and a hand-picked subset silently drops whatever the create form
    collected but this schema forgot, which is exactly what happened to the summary
    settings and the retrieval config.

    Only three things differ: the kind is set by the endpoint rather than the caller,
    the name may be blank, and a repository is required.
    """

    # Blank means "use the repository's own name", filled in by the endpoint. The
    # inherited field requires at least one character.
    name: str = Field(
        "",
        max_length=100,
        description=(
            "Left blank, the repository's own name is used. The client sends what it "
            "resolved for the form; the box itself is not pre-filled, where it would "
            "read as the caller's own input."
        ),
    )
    namespace: Optional[str] = Field(
        None,
        max_length=100,
        description=(
            "Where to file the wiki, as for any other knowledge base. Defaults to "
            "the creator's personal namespace."
        ),
    )
    source_type: Literal["github", "gitlab", "gitea"] = Field(
        ...,
        description=(
            "Which platform hosts the repository. Required because a self-hosted "
            "GitLab or Gitea cannot be told apart by its domain."
        ),
    )
    source_url: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description="Repository the wiki documents",
    )
    language: str = Field(
        "",
        max_length=10,
        description=(
            "What language to generate the pages in. Empty falls back to "
            "WIKI_DEFAULT_LANGUAGE, which is what a wiki created before this field "
            "existed also does."
        ),
    )


class CodeWikiChangedPath(BaseModel):
    """One file the repository changed since the published commit."""

    path: str = Field(..., min_length=1, max_length=1000)
    change_type: Literal["A", "M", "D", "R"] = Field(
        "M",
        description="Git status letter: A added, M modified, D deleted, R renamed",
    )


class CodeWikiListItem(BaseModel):
    """One code wiki, as a list shows it.

    Everything here is read from the knowledge base's spec, written when the version
    was published. A list that had to join every wiki against its generations for
    these three fields would pay for them on every page load.
    """

    id: int
    name: str
    description: Optional[str] = None
    project_name: str = Field("", description="Repository the wiki documents")
    source_url: str = Field("", description="Repository URL")
    last_published_at: Optional[str] = Field(
        None, description="When the live version was published; null if never"
    )
    last_published_commit: str = Field(
        "", description="Commit the live version documents"
    )
    document_count: int = 0
    created_at: datetime
    updated_at: datetime


class CodeWikiListResponse(BaseModel):
    """Code wikis the caller may read."""

    items: List[CodeWikiListItem]
    total: int


class CodeWikiPageNode(BaseModel):
    """One node of the reader's navigation.

    Every node is a page. The hierarchy comes from the page paths and the order from
    the knowledge base's recorded order, so the client renders what it is given
    rather than reassembling a tree from a paginated document list and a separate
    array — two things it would have to keep consistent itself.
    """

    path: str = Field(..., description="Stable page path; identity, not a label")
    title: str = Field(..., description="What the page is called")
    document_id: int = Field(0, description="0 for a section with no page of its own")
    has_content: bool = True
    children: List["CodeWikiPageNode"] = Field(default_factory=list)


class CodeWikiPageTree(BaseModel):
    """The navigation for one code wiki."""

    pages: List[CodeWikiPageNode]


class CodeWikiRunStatus(BaseModel):
    """Whether anything is being done to this wiki, and what came of it last time.

    Separate from the page tree the reader also fetches: while a run is going the
    client polls this, and the tree is large enough that polling it would be the
    wrong thing to repeat every few seconds.
    """

    status: Literal["running", "failed", "completed", "never"]
    generation_id: int = 0
    started_at: Optional[datetime] = None
    error_message: str = Field("", description="Why the last run failed, if it did")
    failure_code: str = Field(
        "",
        description=(
            "Names a failure this server stated in its own words, for a client to "
            "translate. Empty means the reason came from outside — the agent, git, "
            "an exception — and error_message is all there is."
        ),
    )
    is_stale: bool = Field(
        False,
        description=(
            "A run whose worker has gone quiet for longer than the sweep tolerates. "
            "Triggering again reclaims it and starts afresh, so a client may offer "
            "that rather than reporting the wiki as busy."
        ),
    )
    last_published_at: Optional[str] = None
    last_published_commit: str = ""


class CodeWikiRunCreate(BaseModel):
    """Request to regenerate a code wiki now.

    Both fields are optional and describe the repository's current state. Supplying
    neither is safe but expensive: with no commit to compare against, the run cannot
    tell what changed and rebuilds the whole wiki rather than guessing.
    """

    head_commit: str = Field(
        "",
        max_length=64,
        description=(
            "Commit the repository is at now. Compared against the published commit "
            "to decide whether anything needs regenerating at all."
        ),
    )
    changed_paths: Optional[List[CodeWikiChangedPath]] = Field(
        None,
        description=(
            "Files changed since the published commit. Absent means unknown, which "
            "forces a full rebuild; an empty list means nothing changed."
        ),
    )


class CodeWikiRunResponse(BaseModel):
    """What happened when a code wiki was asked to regenerate."""

    started: bool = Field(..., description="Whether a run was actually created")
    mode: str = Field("", description="Run mode chosen: full, incremental or skip")
    reason: str = Field("", description="Why that mode was chosen")
    generation_id: int = Field(0, description="The version being written, when started")
    task_id: int = Field(0, description="Task running the agent, when started")


class CodeWikiRunRecord(BaseModel):
    """One past attempt at generating this wiki.

    Reported per run rather than folded into the wiki's current state because the
    question a reader brings here is not "is it busy" but "why does it look like
    this" — and the answer is usually in a run that already ended.
    """

    generation_id: int
    status: Literal["running", "failed", "completed"]
    mode: str = Field("", description="full or incremental")
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    commit: str = Field("", description="Commit the run was documenting")
    error_message: str = Field("", description="Why it failed, if it did")
    failure_code: str = Field(
        "", description="Names a server-stated failure, for a client to translate"
    )
    published: bool = Field(
        False, description="Whether this is the version readers currently see"
    )
    task_id: int = Field(
        0,
        description=(
            "Task that ran the agent. Openable by id even when the task is kept out "
            "of the conversation list, which is what makes hiding it safe."
        ),
    )


class CodeWikiRunHistory(BaseModel):
    """Recent runs, newest first."""

    runs: List[CodeWikiRunRecord] = Field(default_factory=list)


class CodeWikiExisting(BaseModel):
    """A wiki of this repository somebody has already built."""

    id: int
    name: str
    owner_name: str = Field("", description="Who to ask, when it is not accessible")
    accessible: bool = Field(
        False, description="Whether the caller can already open it"
    )


class CodeWikiResolveRequest(BaseModel):
    """Ask what is known about a repository before binding a wiki to it."""

    source_type: Literal["github", "gitlab", "gitea"]
    source_url: str = Field(..., min_length=1, max_length=500)


class CodeWikiResolveResponse(BaseModel):
    """What the create form needs, in one answer rather than three probes.

    ``exists`` false means "not readable with what you have"; private and absent are
    deliberately not told apart, since distinguishing them would disclose which
    private repositories exist.
    """

    exists: bool
    visibility: str = Field("", description="public or private, when readable")
    default_branch: str = Field("", description="Saves listing branches to pick one")
    name: str = Field("", description="Repository path, offered as the wiki's name")
    description: str = Field("", description="Offered as the wiki's description")
    access: str = Field("none", description="public, member, or none")
    existing_wikis: List["CodeWikiExisting"] = Field(
        default_factory=list,
        description=(
            "Code wikis that already document this repository, whoever owns them. "
            "Named rather than counted: asking for a share needs somebody to ask."
        ),
    )


class KnowledgeBaseTypeUpdate(BaseModel):
    """Schema for updating the default opening view.

    The pattern deliberately excludes ``code_wiki``: it is not a view preference but a
    binding to a source repository, so it can be neither adopted nor abandoned by
    toggling a view. Turning a code wiki into a notebook would orphan its repository
    and version history; the reverse would produce a code wiki with no repository.
    """

    kb_type: str = Field(
        ...,
        pattern="^(notebook|classic)$",
        description="New default opening view: 'notebook' or 'classic'",
    )


class KnowledgeBaseResponse(MultimodalAnalysisResponseFieldsMixin):
    """Schema for knowledge base response."""

    id: int
    name: str
    description: Optional[str] = None
    user_id: int
    namespace: str
    direct_access_requirement: Literal["read", "edit"] = "read"
    source: Optional[Dict[str, Any]] = Field(
        None,
        description=(
            "Repository a code wiki documents. Absent for every other kind, which "
            "is how a client tells them apart without a second request."
        ),
    )
    language: Optional[str] = Field(
        None, description="Language a code wiki's pages are generated in"
    )
    show_generation_task: bool = Field(
        False,
        description=(
            "Whether a code wiki's generation runs appear in the conversation list. "
            "Returned so the edit form can show what is set rather than defaulting "
            "the switch to off and silently turning it off on the next save."
        ),
    )
    kb_type: KnowledgeBaseType = Field(
        KnowledgeBaseType.NOTEBOOK,
        description="What this knowledge base is; see KnowledgeBaseType",
    )
    document_count: int
    is_active: bool
    retrieval_config: Optional[RetrievalConfig] = Field(
        None, description="Retrieval configuration"
    )
    summary_enabled: bool = Field(
        default=False,
        description="Enable automatic summary generation for documents",
    )
    summary_model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference for summary generation",
    )
    summary: Optional[dict] = Field(
        None,
        description="Knowledge base summary (short_summary, long_summary, topics, etc.)",
    )
    guided_questions: Optional[List[str]] = Field(
        None,
        description="Guided questions list (max 3) to show in notebook mode for quick user interaction",
    )

    # Knowledge base tool call limit configuration
    max_calls_per_conversation: int = Field(default=10)
    exempt_calls_before_check: int = Field(default=5)

    created_at: datetime
    updated_at: datetime

    @staticmethod
    def _normalize_retrieval_config_for_response(
        config: Optional[Any], knowledge_base_id: int
    ) -> Optional[Dict[str, Any]]:
        """Drop historical incomplete retrieval configs before response validation."""
        if not isinstance(config, dict):
            return None

        embedding_config = config.get("embedding_config") or {}
        if not isinstance(embedding_config, dict):
            embedding_config = {}

        if config.get("retriever_name") and embedding_config.get("model_name"):
            return config

        logger.warning(
            "Dropping incomplete retrievalConfig from knowledge base response: kb_id=%s",
            knowledge_base_id,
        )
        return None

    @classmethod
    def from_kind(cls, kind, document_count: int = 0):
        """Create response from Kind object

        Args:
            kind: Kind object
            document_count: Document count (should be queried from database)
        """
        spec = kind.json.get("spec", {})
        # Extract summary from spec.summary if available
        summary = spec.get("summary")
        # Extract summary_model_ref from spec
        summary_model_ref = spec.get("summaryModelRef")
        # Extract kb_type from spec, default to 'notebook' for backward compatibility
        kb_type = spec.get("kbType", KnowledgeBaseType.NOTEBOOK.value)
        # Only a code wiki has one. Carried so a list can render the repository on
        # the card and the reader can be linked to, without a second request per row.
        source = spec.get("source")
        language = spec.get("language")

        # Extract guided questions from spec
        guided_questions = spec.get("guidedQuestions")

        # Extract call limit configuration with defaults for backward compatibility
        max_calls = spec.get("maxCallsPerConversation", 10)
        exempt_calls = spec.get("exemptCallsBeforeCheck", 5)

        # Validate: exempt_calls must be < max_calls
        if exempt_calls >= max_calls:
            import logging

            logger = logging.getLogger(__name__)
            logger.warning(
                f"Invalid KB config for {kind.id}: exemptCallsBeforeCheck ({exempt_calls}) "
                f">= maxCallsPerConversation ({max_calls}). Using default values."
            )
            max_calls, exempt_calls = 10, 5

        return cls(
            id=kind.id,
            name=spec.get("name", ""),
            description=spec.get("description") or None,  # Convert empty string to None
            user_id=kind.user_id,
            namespace=kind.namespace,
            direct_access_requirement=spec.get("directAccessRequirement", "read"),
            kb_type=kb_type,
            source=source,
            language=language,
            show_generation_task=bool(spec.get("showGenerationTask", False)),
            document_count=document_count,
            retrieval_config=cls._normalize_retrieval_config_for_response(
                spec.get("retrievalConfig"), kind.id
            ),
            summary_enabled=spec.get("summaryEnabled", False),
            summary_model_ref=summary_model_ref,
            summary=summary,
            guided_questions=guided_questions,
            max_calls_per_conversation=max_calls,
            exempt_calls_before_check=exempt_calls,
            is_active=kind.is_active,
            created_at=kind.created_at,
            updated_at=kind.updated_at,
            **multimodal_response_kwargs(spec),
        )

    class Config:
        from_attributes = True


class KnowledgeBaseListResponse(BaseModel):
    """Schema for knowledge base list response."""

    total: int
    returned_count: int = 0
    limit: int | None = None
    offset: int = 0
    has_more: bool = False
    items: list[KnowledgeBaseResponse]


# ============== Knowledge Document Schemas ==============
# Note: SplitterConfig is imported from app.schemas.rag to use unified splitter configuration


class KnowledgeDocumentCreate(MultimodalDocumentPromptMixin):
    """Schema for creating a knowledge document."""

    attachment_id: Optional[int] = Field(
        None,
        description="ID of the uploaded attachment (required for file/text source)",
    )
    name: str = Field(..., min_length=1, max_length=255)
    file_extension: str = Field(..., max_length=50)
    file_size: int = Field(default=0, ge=0)
    folder_id: int = Field(
        default=0,
        ge=0,
        description="Target folder ID (0 = root level)",
    )
    splitter_config: Optional[SplitterConfig] = None
    source_type: DocumentSourceType = Field(default=DocumentSourceType.FILE)
    source_config: dict = Field(
        default_factory=dict,
        description="Source configuration (e.g., {'url': '...'} for table)",
    )


class KnowledgeDocumentUpdate(BaseModel):
    """Schema for updating a knowledge document."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    status: Optional[DocumentStatus] = None
    splitter_config: Optional[SplitterConfig] = Field(
        None, description="Splitter configuration for document chunking"
    )


class KnowledgeDocumentResponse(BaseModel):
    """Schema for knowledge document response."""

    id: int
    kind_id: int
    attachment_id: Optional[int] = None
    name: str
    file_extension: str
    file_size: int
    status: DocumentStatus
    user_id: int
    created_by: Optional[str] = None  # Creator's username
    is_active: bool
    index_status: DocumentIndexStatus
    index_generation: int
    processing_error: Optional[DocumentProcessingError] = None
    splitter_config: Optional[SplitterConfig] = None
    source_type: DocumentSourceType = DocumentSourceType.FILE
    source_config: Optional[dict] = None
    folder_id: int = Field(default=0, ge=0, description="Folder ID (0 = root level)")
    doc_ref: Optional[str] = Field(
        None, description="RAG storage document reference ID"
    )
    created_at: datetime
    updated_at: datetime

    @field_validator("source_type", mode="before")
    @classmethod
    def ensure_source_type_enum(cls, v):
        """Convert string to DocumentSourceType enum for ORM compatibility."""
        if isinstance(v, str):
            try:
                return DocumentSourceType(v)
            except ValueError:
                return DocumentSourceType.FILE
        return v

    @field_validator("source_config", mode="before")
    @classmethod
    def ensure_source_config_dict(cls, v):
        """Convert None to empty dict for backward compatibility."""
        if v is None:
            return {}
        return v

    @field_validator("splitter_config", mode="before")
    @classmethod
    def normalize_splitter_config_for_response(cls, v):
        """Return normalized splitter config payloads in API responses."""
        if v is None:
            return v
        return normalize_splitter_config(v)

    @model_validator(mode="after")
    def derive_processing_error(self):
        """Expose a validated error without leaking its storage location."""
        source_config = dict(self.source_config or {})
        raw_error = source_config.pop("processing_error", None)
        self.source_config = source_config
        if self.index_status != DocumentIndexStatus.FAILED:
            self.processing_error = None
            return self
        if not isinstance(raw_error, dict):
            if (
                self.processing_error is not None
                and self.processing_error.generation == self.index_generation
            ):
                return self
            self.processing_error = None
            return self
        try:
            error = DocumentProcessingError.model_validate(raw_error)
        except ValueError:
            logger.warning(
                "Invalid processing error payload document_id=%s generation=%s",
                self.id,
                self.index_generation,
            )
            self.processing_error = None
            return self
        self.processing_error = (
            error if error.generation == self.index_generation else None
        )
        return self

    class Config:
        from_attributes = True


class KnowledgeDocumentListResponse(BaseModel):
    """Schema for knowledge document list response."""

    total: int
    returned_count: int = 0
    limit: int | None = None
    offset: int = 0
    has_more: bool = False
    items: list[KnowledgeDocumentResponse]


class KnowledgeDocumentSortField(str, Enum):
    """Supported sort fields for document list queries."""

    NAME = "name"
    SIZE = "size"
    CREATED_AT = "createdAt"
    UPDATED_AT = "updatedAt"


class SortOrder(str, Enum):
    """Supported sort order values."""

    ASC = "asc"
    DESC = "desc"


# ============== Knowledge Folder Schemas ==============


class KnowledgeFolderCreate(BaseModel):
    """Schema for creating a knowledge folder."""

    name: str = Field(..., min_length=1, max_length=255)
    parent_id: int = Field(
        default=0, ge=0, description="Parent folder ID (0 = root level)"
    )

    @field_validator("name")
    @classmethod
    def validate_name_not_whitespace(cls, v: str) -> str:
        """Reject names that are empty or consist only of whitespace."""
        if not v.strip():
            raise ValueError("Folder name must not be empty or whitespace-only")
        return v.strip()


class KnowledgeFolderUpdate(BaseModel):
    """Schema for updating a knowledge folder."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    parent_id: Optional[int] = Field(
        None,
        ge=0,
        description="New parent folder ID (0 = root level, None = no change)",
    )

    @field_validator("name")
    @classmethod
    def validate_name_not_whitespace(cls, v: Optional[str]) -> Optional[str]:
        """Reject names that are empty or consist only of whitespace."""
        if v is not None and not v.strip():
            raise ValueError("Folder name must not be empty or whitespace-only")
        return v.strip() if v is not None else v


class KnowledgeFolderCreateOpen(BaseModel):
    """Schema for creating a knowledge folder through open APIs."""

    knowledge_base_id: int = Field(..., ge=1)
    name: str = Field(..., min_length=1, max_length=255)
    parent_id: int = Field(
        default=0, ge=0, description="Parent folder ID (0 = root level)"
    )

    @field_validator("name")
    @classmethod
    def validate_name_not_whitespace(cls, v: str) -> str:
        """Reject names that are empty or consist only of whitespace."""
        if not v.strip():
            raise ValueError("Folder name must not be empty or whitespace-only")
        return v.strip()


class KnowledgeFolderUpdateOpen(BaseModel):
    """Schema for updating a knowledge folder through open APIs."""

    knowledge_base_id: int = Field(..., ge=1)
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    parent_id: Optional[int] = Field(
        None,
        ge=0,
        description="New parent folder ID (0 = root level, None = no change)",
    )

    @field_validator("name")
    @classmethod
    def validate_name_not_whitespace(cls, v: Optional[str]) -> Optional[str]:
        """Reject names that are empty or consist only of whitespace."""
        if v is not None and not v.strip():
            raise ValueError("Folder name must not be empty or whitespace-only")
        return v.strip() if v is not None else v


class KnowledgeFolderResponse(BaseModel):
    """Schema for knowledge folder response with nested children."""

    id: int
    kind_id: int
    parent_id: int = Field(..., description="Parent folder ID (0 = root level)")
    name: str
    children: list["KnowledgeFolderResponse"] = Field(default_factory=list)
    document_count: int = Field(
        default=0, description="Number of documents in this folder"
    )
    direct_document_count: int = Field(
        default=0, description="Number of documents directly in this folder"
    )
    total_document_count: int = Field(
        default=0, description="Number of documents in this folder subtree"
    )
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class DocumentMoveRequest(BaseModel):
    """Schema for moving a document to a different folder."""

    folder_id: int = Field(..., ge=0, description="Target folder ID (0 = root level)")


class BatchDocumentMoveRequest(BaseModel):
    """Schema for moving multiple documents to a folder."""

    document_ids: list[int] = Field(
        ..., min_length=1, description="List of document IDs to move"
    )
    folder_id: int = Field(..., ge=0, description="Target folder ID (0 = root level)")


# ============== Batch Operation Schemas ==============


class BatchDocumentIds(BaseModel):
    """Schema for batch document operation request."""

    document_ids: list[int] = Field(
        ..., min_length=1, description="List of document IDs to operate on"
    )


class BatchOperationResult(BaseModel):
    """Schema for batch operation result."""

    success_count: int = Field(
        ..., description="Number of successfully processed documents"
    )
    failed_count: int = Field(..., description="Number of failed documents")
    failed_ids: list[int] = Field(
        default_factory=list, description="List of failed document IDs"
    )
    message: str = Field(..., description="Operation result message")


# ============== Accessible Knowledge Schemas ==============


class AccessibleKnowledgeBase(BaseModel):
    """Schema for accessible knowledge base info."""

    id: int
    name: str
    description: Optional[str] = None
    document_count: int
    updated_at: datetime


class TeamKnowledgeGroup(BaseModel):
    """Schema for team knowledge group."""

    group_name: str
    group_display_name: Optional[str] = None
    knowledge_bases: list[AccessibleKnowledgeBase]


class AccessibleKnowledgeResponse(BaseModel):
    """Schema for all accessible knowledge bases response."""

    personal: list[AccessibleKnowledgeBase]
    team: list[TeamKnowledgeGroup]


# ============== All Grouped Knowledge Schemas ==============


class KnowledgeBaseWithGroupInfo(BaseModel):
    """Schema for knowledge base with group info for all-grouped response."""

    id: int
    name: str
    description: Optional[str] = None
    kb_type: Optional[str] = "notebook"
    namespace: str
    document_count: int = 0
    updated_at: datetime
    created_at: datetime
    user_id: int
    # Group info for display
    group_id: str  # namespace or 'default'
    group_name: str  # Display name
    group_type: str  # 'personal' | 'personal-shared' | 'group' | 'organization'
    # User's role/permission for this knowledge base
    my_role: Optional[str] = Field(
        None,
        description="Current user's role for this KB: 'Owner' | 'Maintainer' | 'Developer' | 'Reporter' | 'RestrictedAnalyst' | None",
    )
    # Source group for entity-authorized shared KBs
    source_group: Optional[str] = Field(
        None,
        description="Source group name for entity-authorized shared KBs, e.g., '来自 XX 群组'",
    )
    # Share source user name for shared KBs
    shared_from: Optional[str] = Field(
        None,
        description="Share source user name for shared KBs",
    )
    # Multiple share source user names for multi-source shared KBs in All mode
    shared_from_users: Optional[list[str]] = Field(
        None,
        description="Multiple share source user names for multi-source shared KBs in All mode",
    )
    # Share via entity type: 'user', 'namespace', or other registered entity types
    shared_via: Optional[str] = Field(
        None,
        description="Share via entity type: 'user', 'namespace', or other registered entity types",
    )
    # Knowledge base creator name for display fallback
    owner_name: Optional[str] = Field(
        None,
        description="Knowledge base creator's user name",
    )


class AllGroupedPersonal(BaseModel):
    """Schema for personal knowledge bases in all-grouped response."""

    created_by_me: list[KnowledgeBaseWithGroupInfo]
    shared_with_me: list[KnowledgeBaseWithGroupInfo]


class AllGroupedTeamGroup(BaseModel):
    """Schema for a team group in all-grouped response."""

    group_name: str
    group_display_name: str
    kb_count: int
    knowledge_bases: list[KnowledgeBaseWithGroupInfo]


class AllGroupedOrganization(BaseModel):
    """Schema for organization knowledge bases in all-grouped response."""

    namespace: Optional[str] = None
    display_name: Optional[str] = None
    kb_count: int = 0
    knowledge_bases: list[KnowledgeBaseWithGroupInfo]


class AllGroupedSummary(BaseModel):
    """Schema for summary in all-grouped response."""

    total_count: int
    personal_count: int
    group_count: int
    organization_count: int


class AllGroupedKnowledgeResponse(BaseModel):
    """Schema for all knowledge bases grouped response.

    This is the response for GET /api/v1/knowledge-bases/all-grouped
    which returns all knowledge bases accessible to the user in a single request,
    solving the N+1 query problem.
    """

    personal: AllGroupedPersonal
    groups: list[AllGroupedTeamGroup]
    organization: AllGroupedOrganization
    summary: AllGroupedSummary


class PersonalKnowledgeBaseGroup(BaseModel):
    """Schema for personal knowledge base group (created by me vs shared with me)."""

    created_by_me: list[KnowledgeBaseResponse]
    shared_with_me: list[KnowledgeBaseResponse]


# ============== Table URL Validation Schemas ==============


class TableUrlValidationRequest(BaseModel):
    """Schema for table URL validation request."""

    url: str = Field(..., min_length=1, description="The table URL to validate")


class TableUrlValidationResponse(BaseModel):
    """Schema for table URL validation response."""

    valid: bool = Field(..., description="Whether the URL is valid")
    provider: Optional[str] = Field(
        None, description="Detected table provider (e.g., 'dingtalk')"
    )
    base_id: Optional[str] = Field(None, description="Extracted base ID from URL")
    sheet_id: Optional[str] = Field(None, description="Extracted sheet ID from URL")
    error_code: Optional[str] = Field(
        None, description="Error code if validation failed"
    )
    error_message: Optional[str] = Field(
        None, description="Error message if validation failed"
    )


# ============== Document Detail Schemas ==============


class DocumentDetailResponse(BaseModel):
    """Schema for document detail response (content + summary)."""

    document_id: int = Field(..., description="Document ID")
    content: Optional[str] = Field(
        None, description="Extracted text content from document"
    )
    content_length: Optional[int] = Field(
        None, description="Length of content in characters"
    )
    truncated: Optional[bool] = Field(None, description="Whether content was truncated")
    summary: Optional[dict] = Field(None, description="Document summary object")


class DocumentContentReadResponse(BaseModel):
    """Schema for raw document content reads with pagination metadata."""

    document_id: int = Field(..., description="Document ID")
    name: str = Field(..., description="Document name")
    content: str = Field(..., description="Document content (partial)")
    total_length: int = Field(
        ..., ge=0, description="Total document length in characters"
    )
    offset: int = Field(..., ge=0, description="Actual start position")
    returned_length: int = Field(..., ge=0, description="Number of characters returned")
    has_more: bool = Field(..., description="Whether more content is available")
    kb_id: int = Field(..., description="Knowledge base ID")
    index_status: DocumentIndexStatus = Field(
        ..., description="Document indexing status"
    )


class DocumentContentUpdate(BaseModel):
    """Schema for updating document content (TEXT type only)."""

    content: str = Field(
        ..., min_length=1, max_length=500000, description="New Markdown content"
    )


# ============== Web Scraper Schemas ==============


class WebScrapeRequest(BaseModel):
    """Schema for web scrape request."""

    url: str = Field(..., min_length=1, description="URL to scrape")


class WebScrapeResponse(BaseModel):
    """Schema for web scrape response."""

    title: Optional[str] = Field(None, description="Page title")
    content: str = Field(..., description="Markdown content")
    url: str = Field(..., description="Source URL")
    scraped_at: str = Field(..., description="Scrape timestamp (ISO format)")
    content_length: int = Field(0, description="Content length in characters")
    description: Optional[str] = Field(None, description="Page description")
    success: bool = Field(True, description="Whether scraping succeeded")
    error_code: Optional[str] = Field(None, description="Error code if failed")
    error_message: Optional[str] = Field(None, description="Error message if failed")


# ============== Chunk Schemas ==============


class ChunkItem(BaseModel):
    """Schema for a single chunk item."""

    index: int = Field(..., ge=0, description="Chunk index (0-based)")
    content: str = Field(..., description="Chunk text content")
    token_count: int = Field(0, ge=0, description="Token count for this chunk")
    start_position: int = Field(
        0, ge=0, description="Start position in original document"
    )
    end_position: int = Field(0, ge=0, description="End position in original document")


class ChunkMetadata(BaseModel):
    """Schema for document chunks metadata stored in database."""

    items: list[ChunkItem] = Field(
        default_factory=list, description="List of chunk items"
    )
    total_count: int = Field(0, ge=0, description="Total number of chunks")
    splitter_type: str = Field(
        "flat",
        description="Normalized chunk strategy used for indexing (flat|hierarchical|semantic)",
    )
    splitter_subtype: Optional[str] = Field(
        None,
        description="Optional parser subtype resolved during format enhancement",
    )
    qa_pair_count: int = Field(
        0,
        ge=0,
        description="Number of detected Q/A pairs when Q/A unitization is used",
    )
    created_at: str = Field(..., description="Chunk creation timestamp (ISO format)")


class ChunkResponse(BaseModel):
    """Schema for single chunk response."""

    index: int = Field(..., ge=0, description="Chunk index (0-based)")
    content: str = Field(..., description="Full chunk content")
    token_count: int = Field(0, ge=0, description="Token count for this chunk")
    document_name: str = Field(..., description="Document name")
    document_id: int = Field(..., description="Document ID")
    kb_id: int = Field(..., description="Knowledge base ID")


class ChunkListResponse(BaseModel):
    """Schema for chunk list response with pagination."""

    total: int = Field(..., description="Total number of chunks")
    page: int = Field(1, ge=1, description="Current page number")
    page_size: int = Field(20, ge=1, le=100, description="Page size")
    items: list[ChunkItem] = Field(default_factory=list, description="Chunk items")
    splitter_type: Optional[str] = Field(
        None,
        description="Normalized chunk strategy used for indexing (flat|hierarchical|semantic)",
    )
    splitter_subtype: Optional[str] = Field(
        None,
        description="Optional parser subtype resolved during format enhancement",
    )
    qa_pair_count: int = Field(
        0,
        ge=0,
        description="Number of detected Q/A pairs when Q/A unitization is used",
    )


# ============== Citation Schemas ==============


class CandidateChunk(BaseModel):
    """Schema for a candidate chunk from retrieval (internal use, passed to AI)."""

    retrieval_index: int = Field(
        ..., ge=1, description="Retrieval result index (1-based), for AI citation"
    )
    kb_id: int = Field(..., description="Knowledge base ID")
    document_id: int = Field(..., description="Document ID")
    document_name: str = Field(..., description="Document name")
    chunk_index: int = Field(..., ge=0, description="Chunk index in document (0-based)")
    content: str = Field(..., description="Chunk full content")
    score: float = Field(..., ge=0.0, le=1.0, description="Retrieval relevance score")


class CitationSource(BaseModel):
    """Schema for citation source returned to frontend (after filtering and re-indexing)."""

    index: int = Field(
        ...,
        ge=1,
        description="Re-indexed citation number (1, 2, 3...), corresponds to [1], [2], [3] in AI response",
    )
    kb_id: int = Field(..., description="Knowledge base ID")
    document_id: int = Field(..., description="Document ID")
    document_name: str = Field(..., description="Document name")
    chunk_index: int = Field(
        ..., ge=0, description="Chunk index in document (0-based), for precise location"
    )


# ============== Knowledge Base Migration Schemas ==============


class KnowledgeBaseMigrateRequest(BaseModel):
    """Schema for migrating knowledge base to group request."""

    target_group_name: str = Field(
        ...,
        min_length=1,
        description="Target group name (namespace) to migrate the knowledge base to",
    )


class KnowledgeBaseMigrateResponse(BaseModel):
    """Schema for knowledge base migration response."""

    success: bool = Field(..., description="Whether migration succeeded")
    message: str = Field(..., description="Migration result message")
    knowledge_base_id: int = Field(..., description="Knowledge base ID")
    old_namespace: str = Field(..., description="Original namespace")
    new_namespace: str = Field(..., description="New namespace after migration")


# ============== Document Transfer Schemas ==============


class TransferDocumentsRequest(BaseModel):
    """Schema for transferring documents/folders to another knowledge base."""

    document_ids: list[int] = Field(
        default_factory=list, description="List of document IDs to transfer"
    )
    folder_ids: list[int] = Field(
        default_factory=list,
        description="List of folder IDs to transfer with their contents",
    )
    target_kb_id: int = Field(..., description="Target knowledge base ID")


class TransferDocumentsResponse(BaseModel):
    """Schema for document transfer response."""

    success: bool = Field(..., description="Whether transfer succeeded")
    message: str = Field(..., description="Transfer result message")
    transferred_document_count: int = Field(
        ..., description="Number of documents transferred"
    )
    transferred_folder_count: int = Field(
        ..., description="Number of folders transferred"
    )
    deleted_folder_count: int = Field(
        default=0,
        description="Number of empty folders deleted from source KB after transfer",
    )
    source_kb_id: int = Field(..., description="Source knowledge base ID")
    target_kb_id: int = Field(..., description="Target knowledge base ID")


# ============== v1 API Schemas ==============

# Maximum allowed binary size for base64-encoded file uploads (10 MiB)
_MAX_FILE_DECODED_BYTES = 10 * 1024 * 1024
_MAX_FILE_BASE64_LEN = ((_MAX_FILE_DECODED_BYTES + 2) // 3) * 4  # 13_981_016


class KnowledgeDocumentCreateV1(BaseModel):
    """Request schema for v1 document creation endpoint.

    Accepts all source types; unsupported types are rejected at the
    handler level with a descriptive error.
    """

    knowledge_base_id: int = Field(..., description="Target knowledge base ID")
    name: str = Field(..., min_length=1, max_length=255, description="Document name")
    source_type: DocumentSourceType = Field(
        DocumentSourceType.TEXT,
        description=(
            "Document source type: 'text' (inline content), 'file' (base64 binary), "
            "'web' (URL scraping), 'attachment' (existing attachment ID)"
        ),
    )
    # source_type=text
    content: Optional[str] = Field(
        None,
        min_length=1,
        max_length=500_000,
        description="Text content (required for source_type='text')",
    )
    file_extension: Optional[str] = Field(
        None,
        max_length=50,
        description="File extension without leading dot, e.g. 'md' (optional for source_type='text')",
    )
    # source_type=file
    file_base64: Optional[str] = Field(
        None,
        max_length=_MAX_FILE_BASE64_LEN,
        description="Base64-encoded file binary (required for source_type='file', max 10 MB decoded)",
    )
    # source_type=web
    url: Optional[str] = Field(
        None,
        description="URL to scrape (required for source_type='web')",
    )
    # source_type=attachment
    attachment_id: Optional[int] = Field(
        None,
        description="Attachment context ID (required for source_type='attachment')",
    )
    # common optional
    folder_id: int = Field(0, ge=0, description="Target folder ID (0 = root level)")
    splitter_config: Optional[SplitterConfig] = Field(
        None,
        description="Custom text splitter configuration",
    )


class DocumentContentUpdateResponse(BaseModel):
    """Response schema for the v1 document content update endpoint."""

    success: bool = Field(..., description="Whether the update succeeded")
    document_id: int = Field(..., description="ID of the updated document")
    message: str = Field(..., description="Human-readable result message")
