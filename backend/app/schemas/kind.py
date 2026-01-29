# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kubernetes-style API schemas for cloud-native agent management
"""
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import AliasChoices, BaseModel, Field


# API Format Enum for OpenAI-compatible models
class ApiFormat(str, Enum):
    """
    API format for OpenAI-compatible models.

    - CHAT_COMPLETIONS: Traditional /v1/chat/completions API (default)
    - RESPONSES: New /v1/responses API (recommended for agent scenarios)
    """

    CHAT_COMPLETIONS = "chat/completions"
    RESPONSES = "responses"


# Model Category Type Enum (different from resource type public/user/group)
class ModelCategoryType(str, Enum):
    """
    Model category type enumeration for distinguishing model capabilities.

    - LLM: Large Language Models for chat/code (default, backward compatible)
    - TTS: Text-to-Speech models
    - STT: Speech-to-Text models
    - EMBEDDING: Vector embedding models
    - RERANK: Reranking models
    """

    LLM = "llm"
    TTS = "tts"
    STT = "stt"
    EMBEDDING = "embedding"
    RERANK = "rerank"


# Type-specific configurations
class TTSConfig(BaseModel):
    """TTS-specific configuration"""

    voice: Optional[str] = Field(
        None, description="Voice ID (e.g., 'alloy', 'echo' for OpenAI)"
    )
    speed: Optional[float] = Field(
        1.0, ge=0.25, le=4.0, description="Speech speed (0.25-4.0)"
    )
    output_format: Optional[str] = Field("mp3", description="Output format (mp3, wav)")


class STTConfig(BaseModel):
    """STT-specific configuration"""

    language: Optional[str] = Field(
        None, description="Language code (e.g., 'en', 'zh')"
    )
    transcription_format: Optional[str] = Field(
        "text", description="Response format (text, srt, vtt)"
    )


class EmbeddingConfig(BaseModel):
    """Embedding-specific configuration"""

    dimensions: Optional[int] = Field(
        None, description="Output dimensions (e.g., 1536)"
    )
    encoding_format: Optional[str] = Field(
        "float", description="Encoding format (float, base64)"
    )


class RerankConfig(BaseModel):
    """Rerank-specific configuration"""

    top_n: Optional[int] = Field(None, description="Number of top results to return")
    return_documents: Optional[bool] = Field(
        True, description="Whether to return document texts"
    )


class ObjectMeta(BaseModel):
    """Standard Kubernetes object metadata"""

    name: str
    namespace: str = "default"
    displayName: Optional[str] = None  # Human-readable display name
    labels: Optional[Dict[str, str]] = None
    # annotations: Optional[Dict[str, str]] = None


class Status(BaseModel):
    """Standard status object"""

    state: str
    message: Optional[str] = None
    # conditions: Optional[List[Dict[str, Any]]] = None


# Ghost CRD schemas
class GhostSpec(BaseModel):
    """Ghost specification"""

    systemPrompt: str
    mcpServers: Optional[Dict[str, Any]] = None
    skills: Optional[List[str]] = None  # Skill names list
    preload_skills: Optional[List[str]] = Field(
        None,
        description="List of skill names to preload into system prompt. "
        "Must be a subset of skills. When specified, these skills' prompts "
        "will be automatically injected into the system message.",
    )


class GhostStatus(Status):
    """Ghost status"""

    state: str = "Available"  # Available, Unavailable


class Ghost(BaseModel):
    """Ghost CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Ghost"
    metadata: ObjectMeta
    spec: GhostSpec
    status: Optional[GhostStatus] = None


class GhostList(BaseModel):
    """Ghost list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "GhostList"
    items: List[Ghost]


# Model CRD schemas
class ModelSpec(BaseModel):
    """Model specification"""

    modelConfig: Dict[str, Any]
    isCustomConfig: Optional[bool] = (
        None  # True if user customized the config, False/None if using predefined model
    )
    protocol: Optional[str] = (
        None  # Model protocol type: 'openai', 'claude', etc. Required for custom configs
    )

    # API format for OpenAI-compatible models
    apiFormat: Optional[ApiFormat] = Field(
        None,
        description="API format for OpenAI-compatible models. "
        "'chat/completions' for traditional API (default), "
        "'responses' for new Responses API (recommended for agent scenarios). "
        "Only applies when protocol is 'openai'.",
    )

    # Context window and output token limits for LLM models
    contextWindow: Optional[int] = Field(
        None,
        description="Maximum context window size in tokens. Used for message compression.",
    )
    maxOutputTokens: Optional[int] = Field(
        None,
        description="Maximum output tokens the model can generate per response.",
    )

    # New fields for multi-type model support
    modelType: Optional[ModelCategoryType] = Field(
        ModelCategoryType.LLM,
        description="Model category type (llm, tts, stt, embedding, rerank). Defaults to 'llm' for backward compatibility.",
    )
    ttsConfig: Optional[TTSConfig] = Field(
        None, description="TTS-specific configuration (when modelType='tts')"
    )
    sttConfig: Optional[STTConfig] = Field(
        None, description="STT-specific configuration (when modelType='stt')"
    )
    embeddingConfig: Optional[EmbeddingConfig] = Field(
        None,
        description="Embedding-specific configuration (when modelType='embedding')",
    )
    rerankConfig: Optional[RerankConfig] = Field(
        None, description="Rerank-specific configuration (when modelType='rerank')"
    )


class ModelStatus(Status):
    """Model status"""

    state: str = "Available"  # Available, Unavailable


class Model(BaseModel):
    """Model CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Model"
    metadata: ObjectMeta
    spec: ModelSpec
    status: Optional[ModelStatus] = None


class ModelList(BaseModel):
    """Model list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "ModelList"
    items: List[Model]


# Shell CRD schemas
class ModelRef(BaseModel):
    """Reference to a Model"""

    name: str
    namespace: str = "default"


class ShellSpec(BaseModel):
    """Shell specification"""

    shellType: str = Field(
        ..., validation_alias=AliasChoices("shellType", "runtime")
    )  # Agent type: 'ClaudeCode', 'Agno', 'Dify', etc. Accepts 'runtime' for backward compatibility
    supportModel: Optional[List[str]] = None
    baseImage: Optional[str] = None  # Custom base image address for user-defined shells
    baseShellRef: Optional[str] = (
        None  # Reference to base public shell (e.g., "ClaudeCode")
    )
    requiresWorkspace: Optional[bool] = Field(
        default=None,
        description="Whether this shell requires a workspace/repository. Defaults to True for local_engine types (ClaudeCode, Agno), False for external_api types (Dify, Chat).",
    )


class ShellStatus(Status):
    """Shell status"""

    state: str = "Available"  # Available, Unavailable


class Shell(BaseModel):
    """Shell CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Shell"
    metadata: ObjectMeta
    spec: ShellSpec
    status: Optional[ShellStatus] = None


class ShellList(BaseModel):
    """Shell list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "ShellList"
    items: List[Shell]


# Bot CRD schemas
class GhostRef(BaseModel):
    """Reference to a Ghost"""

    name: str
    namespace: str = "default"


class ShellRef(BaseModel):
    """Reference to a Shell"""

    name: str
    namespace: str = "default"


class BotSpec(BaseModel):
    """Bot specification"""

    ghostRef: GhostRef
    shellRef: ShellRef
    modelRef: Optional[ModelRef] = None


class BotStatus(Status):
    """Bot status"""

    state: str = "Available"  # Available, Unavailable


class Bot(BaseModel):
    """Bot CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Bot"
    metadata: ObjectMeta
    spec: BotSpec
    status: Optional[BotStatus] = None


class BotList(BaseModel):
    """Bot list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "BotList"
    items: List[Bot]


# Team CRD schemas
class BotTeamRef(BaseModel):
    """Reference to a Bot in Team"""

    name: str
    namespace: str = "default"


class TeamMember(BaseModel):
    """Team member specification"""

    botRef: BotTeamRef
    prompt: Optional[str] = None
    role: Optional[str] = None
    requireConfirmation: Optional[bool] = (
        False  # Whether this stage requires user confirmation before proceeding to next stage (Pipeline mode only)
    )


class TeamSpec(BaseModel):
    """Team specification"""

    members: List[TeamMember]
    collaborationModel: str  # pipeline、route、coordinate、collaborate
    bind_mode: Optional[List[str]] = None  # ['chat', 'code'] or empty list for none
    description: Optional[str] = None  # Team description
    icon: Optional[str] = None  # Icon ID from preset icon library
    requiresWorkspace: Optional[bool] = Field(
        default=None,
        description="Whether this team requires a workspace/repository. "
        "If not set (None), it will be inferred from the underlying shell types. "
        "Set to True to always require workspace, False to never require workspace.",
    )


class TeamStatus(Status):
    """Team status"""

    state: str = "Available"  # Available, Unavailable


class Team(BaseModel):
    """Team CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Team"
    metadata: ObjectMeta
    spec: TeamSpec
    status: Optional[TeamStatus] = None


class TeamList(BaseModel):
    """Team list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "TeamList"
    items: List[Team]


# Workspace CRD schemas
class Repository(BaseModel):
    """Repository configuration"""

    gitUrl: str
    gitRepo: str
    gitRepoId: Optional[int] = None
    branchName: str
    gitDomain: str


class WorkspaceSpec(BaseModel):
    """Workspace specification"""

    repository: Repository


class WorkspaceStatus(Status):
    """Workspace status"""

    state: str = "Available"  # Available, Unavailable


class Workspace(BaseModel):
    """Workspace CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Workspace"
    metadata: ObjectMeta
    spec: WorkspaceSpec
    status: Optional[WorkspaceStatus] = None


class WorkspaceList(BaseModel):
    """Workspace list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "WorkspaceList"
    items: List[Workspace]


# Task CRD schemas
class TeamTaskRef(BaseModel):
    """Reference to a Team"""

    name: str
    namespace: str = "default"


class WorkspaceTaskRef(BaseModel):
    """Reference to a Workspace"""

    name: str
    namespace: str = "default"


class KnowledgeBaseTaskRef(BaseModel):
    """Reference to a KnowledgeBase bound to a Task (group chat)

    Note: The 'id' field stores Kind.id for stable references.
    The 'name' field stores the display name (spec.name) for backward compatibility.
    When looking up a knowledge base:
    1. If 'id' exists, query by Kind.id directly (preferred)
    2. If 'id' is None, fall back to name + namespace lookup (legacy data)
    """

    id: Optional[int] = None  # Knowledge base Kind.id (primary reference)
    name: str  # Display name (spec.name), kept for backward compatibility
    namespace: str = "default"
    boundBy: Optional[str] = None  # Username of the person who bound this KB
    boundAt: Optional[str] = None  # Binding timestamp in ISO format


class TaskSpec(BaseModel):
    """Task specification"""

    title: str
    prompt: str
    teamRef: TeamTaskRef
    workspaceRef: WorkspaceTaskRef
    is_group_chat: bool = False  # Whether this task is a group chat
    knowledgeBaseRefs: Optional[List[KnowledgeBaseTaskRef]] = (
        None  # Bound knowledge bases for group chat
    )


class TaskApp(BaseModel):
    """App preview information (set by expose_service tool when service starts)"""

    name: str
    address: str
    previewUrl: str


class TaskStatus(Status):
    """Task status"""

    state: str = "Available"  # Available, Unavailable
    status: str = "PENDING"  # PENDING, RUNNING, COMPLETED, FAILED, CANCELLED, DELETE
    progress: int = 0
    result: Optional[Dict[str, Any]] = None
    errorMessage: Optional[str] = None
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None
    completedAt: Optional[datetime] = None
    subTasks: Optional[List[Dict[str, Any]]] = None
    app: Optional[TaskApp] = None  # App preview information


class Task(BaseModel):
    """Task CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Task"
    metadata: ObjectMeta
    spec: TaskSpec
    status: Optional[TaskStatus] = None


class TaskList(BaseModel):
    """Task list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "TaskList"
    items: List[Task]


class BatchResponse(BaseModel):
    """Batch operation response"""

    success: bool
    message: str
    results: List[Dict[str, Any]]


# Skill CRD schemas
class SkillSource(BaseModel):
    """Source information for skills imported from Git repositories"""

    type: str = Field(
        "upload",
        description="Source type: 'upload' (manual upload) or 'git' (imported from Git repository)",
    )
    repo_url: Optional[str] = Field(
        None, description="Git repository URL (for git source type)"
    )
    skill_path: Optional[str] = Field(
        None, description="Path to skill in the repository (for git source type)"
    )
    imported_at: Optional[str] = Field(
        None, description="Timestamp when the skill was imported (ISO format)"
    )


class SkillToolDeclaration(BaseModel):
    """Tool declaration in skill configuration.

    Defines a tool that should be dynamically loaded when the skill is active.
    """

    name: str = Field(..., description="Tool name")
    provider: str = Field(..., description="Provider name")
    config: Optional[Dict[str, Any]] = Field(
        None, description="Tool-specific configuration"
    )


class SkillProviderConfig(BaseModel):
    """Provider configuration for dynamic loading from skill

    Specifies the module and class to load as the SkillToolProvider.
    The provider.py file should be included in the skill ZIP package.
    """

    module: str = Field(
        "provider",
        description="Module name (without .py extension), e.g., 'provider'",
    )
    class_name: str = Field(
        ...,
        alias="class",
        description="Provider class name",
    )


class SkillSpec(BaseModel):
    """Skill specification"""

    description: str  # Trigger condition description (from SKILL.md YAML frontmatter)
    displayName: Optional[str] = (
        None  # Friendly display name shown when tool is being used (e.g., "正在渲染图表")
    )
    prompt: Optional[str] = None  # Full prompt content (from SKILL.md body)
    version: Optional[str] = None  # Skill version
    author: Optional[str] = None  # Author
    tags: Optional[List[str]] = None  # Tags
    bindShells: Optional[List[str]] = Field(
        None,
        description="List of shell types this skill is compatible with. "
        "Valid values: 'ClaudeCode', 'Agno', 'Dify', 'Chat'. "
        "REQUIRED: Skills must explicitly specify bindShells to be available. "
        "If not specified or empty, the skill will NOT be available for any shell type.",
    )
    config: Optional[Dict[str, Any]] = Field(
        None,
        description="Skill-level configuration shared by all tools. "
        "Tool-specific configs override these values.",
    )
    tools: Optional[List[SkillToolDeclaration]] = Field(
        None,
        description="Tool declarations for skill-tool binding. "
        "Each tool is dynamically loaded via SkillToolRegistry.",
    )
    provider: Optional[SkillProviderConfig] = Field(
        None,
        description="Provider configuration for dynamic loading. "
        "If specified, the provider will be loaded from the skill .",
    )
    mcpServers: Optional[Dict[str, Any]] = Field(
        None,
        description="MCP servers configuration for this skill. "
        "When the skill is loaded, these MCP servers will be connected "
        "and their tools will be available to the AI. "
        "Format follows the standard MCP server configuration schema.",
    )
    source: Optional[SkillSource] = Field(
        None,
        description="Source information for the skill. "
        "Tracks where the skill was imported from (upload or git repository). "
        "Used to enable updating skills from their original Git source.",
    )


class SkillStatus(Status):
    """Skill status"""

    state: str = "Available"  # Available, Unavailable
    fileSize: Optional[int] = None  # ZIP package size in bytes
    fileHash: Optional[str] = None  # SHA256 hash


class Skill(BaseModel):
    """Skill CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Skill"
    metadata: ObjectMeta
    spec: SkillSpec
    status: Optional[SkillStatus] = None


class SkillList(BaseModel):
    """Skill list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "SkillList"
    items: List[Skill]


# KnowledgeBase CRD schemas
class EmbeddingModelRef(BaseModel):
    """Reference to an Embedding Model"""

    model_name: str = Field(..., description="Embedding model name")
    model_namespace: str = Field("default", description="Embedding model namespace")


class RetrieverRef(BaseModel):
    """Reference to a Retriever"""

    name: str
    namespace: str = "default"


class HybridWeights(BaseModel):
    """Hybrid search weights configuration"""

    vector_weight: float = Field(
        0.7, ge=0.0, le=1.0, description="Weight for vector search (0.0-1.0)"
    )
    keyword_weight: float = Field(
        0.3, ge=0.0, le=1.0, description="Weight for keyword search (0.0-1.0)"
    )

    def model_post_init(self, __context):
        """Validate that weights sum to 1.0"""
        total = self.vector_weight + self.keyword_weight
        if not (0.99 <= total <= 1.01):  # Allow small floating point errors
            raise ValueError(f"Weights must sum to 1.0, got {total}")


class RetrievalConfig(BaseModel):
    """Retrieval configuration for knowledge base"""

    retriever_name: str = Field(..., description="Retriever name")
    retriever_namespace: str = Field("default", description="Retriever namespace")
    embedding_config: EmbeddingModelRef = Field(
        ..., description="Embedding model configuration"
    )
    retrieval_mode: str = Field(
        "vector", description="Retrieval mode: 'vector', 'keyword', or 'hybrid'"
    )
    top_k: int = Field(5, ge=1, le=10, description="Number of results to return")
    score_threshold: float = Field(
        0.7, ge=0.0, le=1.0, description="Minimum score threshold"
    )
    hybrid_weights: Optional[HybridWeights] = Field(
        None, description="Hybrid search weights"
    )


class SummaryModelRef(BaseModel):
    """Reference to a Model for summary generation"""

    name: str = Field(..., description="Model name")
    namespace: str = Field("default", description="Model namespace")
    type: str = Field(
        "public",
        description="Model type: 'public' (system public model), 'user' (personal model), or 'group' (group model)",
    )


class KnowledgeBaseSpec(BaseModel):
    """KnowledgeBase specification"""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    kbType: Optional[str] = Field(
        "notebook",
        description="Knowledge base type: 'notebook' (3-column layout with chat) or 'classic' (document list only)",
    )
    document_count: Optional[int] = Field(
        default=0, description="Cached document count"
    )
    retrievalConfig: Optional[RetrievalConfig] = Field(
        None, description="Retrieval configuration"
    )
    summaryEnabled: bool = Field(
        default=False,
        description="Enable automatic summary generation for documents",
    )
    summaryModelRef: Optional[SummaryModelRef] = Field(
        None,
        description="Model reference for summary generation. Required when summaryEnabled=True",
    )


class KnowledgeBaseStatus(Status):
    """KnowledgeBase status"""

    state: str = "Available"  # Available, Unavailable


class KnowledgeBase(BaseModel):
    """KnowledgeBase CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "KnowledgeBase"
    metadata: ObjectMeta
    spec: KnowledgeBaseSpec
    status: Optional[KnowledgeBaseStatus] = None


class KnowledgeBaseList(BaseModel):
    """KnowledgeBase list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "KnowledgeBaseList"
    items: List[KnowledgeBase]


# Retriever CRD schemas
class IndexStrategy(BaseModel):
    """Index naming strategy configuration"""

    mode: str  # 'fixed', 'rolling', 'per_dataset', 'per_user'
    fixedName: Optional[str] = None  # For 'fixed' mode: single index name
    rollingStep: Optional[int] = None  # For 'rolling' mode: step size (e.g., 5000)
    prefix: Optional[str] = None  # For 'per_dataset'/'per_user' mode: index prefix


class StorageConfig(BaseModel):
    """Storage backend configuration"""

    type: str  # 'elasticsearch' or 'qdrant'
    url: str  # Connection URL
    username: Optional[str] = None  # Username for authentication
    password: Optional[str] = None  # Password for authentication
    apiKey: Optional[str] = (
        None  # API key for authentication (alternative to username/password)
    )
    indexStrategy: IndexStrategy  # Index naming strategy
    ext: Optional[Dict[str, Any]] = None  # Additional provider-specific config


class RetrievalMethod(BaseModel):
    """Retrieval method configuration"""

    enabled: bool = True
    defaultWeight: Optional[float] = None  # Default weight for hybrid search


class RetrieverSpec(BaseModel):
    """Retriever specification"""

    storageConfig: StorageConfig
    retrievalMethods: Dict[str, RetrievalMethod] = Field(
        default_factory=lambda: {
            "vector": RetrievalMethod(enabled=True, defaultWeight=0.7),
            "keyword": RetrievalMethod(enabled=True, defaultWeight=0.3),
            "hybrid": RetrievalMethod(enabled=True),
        }
    )
    description: Optional[str] = None


class Retriever(BaseModel):
    """Retriever CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Retriever"
    metadata: ObjectMeta
    spec: RetrieverSpec


class RetrieverList(BaseModel):
    """Retriever list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "RetrieverList"
    items: List[Retriever]


# Device CRD schemas
class DeviceSpec(BaseModel):
    """Device specification for local device registration"""

    deviceId: str = Field(
        ...,
        description="Device unique identifier (self-generated, e.g., MAC/UUID)",
    )
    displayName: Optional[str] = Field(
        None,
        description="Human-readable device name",
    )
    isDefault: bool = Field(
        default=False,
        description="Whether this is the default device for the user",
    )
    capabilities: Optional[List[str]] = Field(
        None,
        description="Device capabilities/tags (e.g., 'gpu', 'high-memory')",
    )


class DeviceStatus(Status):
    """Device status"""

    state: str = "Available"  # Available, Unavailable
    online: bool = False  # Derived from Redis at query time
    deviceStatus: str = "offline"  # online, offline, busy (from Redis)
    lastHeartbeat: Optional[datetime] = None


class Device(BaseModel):
    """Device CRD for local device management"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Device"
    metadata: ObjectMeta
    spec: DeviceSpec
    status: Optional[DeviceStatus] = None


class DeviceList(BaseModel):
    """Device list"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "DeviceList"
    items: List[Device]


# Git Skill Import schemas
class GitSkillInfo(BaseModel):
    """Information about a skill found in a Git repository"""

    path: str = Field(
        ..., description="Path in the repository (e.g., 'skills/pdf-reader')"
    )
    name: str = Field(
        ..., description="Skill name extracted from path (directory name)"
    )
    description: str = Field(..., description="Description from SKILL.md frontmatter")
    version: Optional[str] = Field(
        None, description="Version from SKILL.md frontmatter"
    )
    author: Optional[str] = Field(None, description="Author from SKILL.md frontmatter")
    display_name: Optional[str] = Field(
        None, description="Display name from SKILL.md frontmatter"
    )
    tags: Optional[List[str]] = Field(
        None, description="Tags from SKILL.md frontmatter"
    )


class GitScanResponse(BaseModel):
    """Response from scanning a Git repository for skills"""

    repo_url: str = Field(..., description="The scanned repository URL")
    skills: List[GitSkillInfo] = Field(
        default_factory=list, description="List of skills found in the repository"
    )
    total_count: int = Field(0, description="Total number of skills found")


class GitImportRequest(BaseModel):
    """Request to import skills from a Git repository"""

    repo_url: str = Field(..., description="Git repository URL")
    skill_paths: List[str] = Field(
        ..., description="List of skill paths to import (e.g., ['skills/pdf-reader'])"
    )
    namespace: str = Field("default", description="Namespace for the imported skills")
    overwrite_names: Optional[List[str]] = Field(
        None,
        description="List of skill names that can be overwritten if they already exist",
    )


class GitImportSuccessItem(BaseModel):
    """Successfully imported skill information"""

    name: str = Field(..., description="Skill name")
    path: str = Field(..., description="Skill path in repository")
    id: int = Field(..., description="Created/updated skill ID")
    action: str = Field(..., description="Action taken: 'created' or 'updated'")


class GitImportSkippedItem(BaseModel):
    """Skipped skill information (due to name conflict)"""

    name: str = Field(..., description="Skill name")
    path: str = Field(..., description="Skill path in repository")
    reason: str = Field(..., description="Reason for skipping")


class GitImportFailedItem(BaseModel):
    """Failed skill import information"""

    name: str = Field(..., description="Skill name")
    path: str = Field(..., description="Skill path in repository")
    error: str = Field(..., description="Error message")


class GitImportResponse(BaseModel):
    """Response from importing skills from a Git repository"""

    success: List[GitImportSuccessItem] = Field(
        default_factory=list, description="Successfully imported skills"
    )
    skipped: List[GitImportSkippedItem] = Field(
        default_factory=list, description="Skipped skills (due to name conflict)"
    )
    failed: List[GitImportFailedItem] = Field(
        default_factory=list, description="Failed skill imports"
    )
    total_success: int = Field(
        0, description="Total number of successfully imported skills"
    )
    total_skipped: int = Field(0, description="Total number of skipped skills")
    total_failed: int = Field(0, description="Total number of failed imports")


# Git Skill Batch Update schemas
class GitBatchUpdateRequest(BaseModel):
    """Request to batch update skills from their Git repository sources"""

    skill_ids: List[int] = Field(
        ...,
        description="List of skill IDs to update from their Git sources. "
        "Skills from the same repository will be updated together with a single download.",
    )


class GitBatchUpdateSuccessItem(BaseModel):
    """Successfully updated skill information"""

    id: int = Field(..., description="Skill ID")
    name: str = Field(..., description="Skill name")
    version: Optional[str] = Field(None, description="Updated skill version")
    source: Optional[Dict[str, Any]] = Field(
        None, description="Updated source information"
    )


class GitBatchUpdateSkippedItem(BaseModel):
    """Skipped skill information (not found, not from git, etc.)"""

    id: int = Field(..., description="Skill ID")
    name: Optional[str] = Field(None, description="Skill name (if found)")
    reason: str = Field(..., description="Reason for skipping")


class GitBatchUpdateFailedItem(BaseModel):
    """Failed skill update information"""

    id: int = Field(..., description="Skill ID")
    name: Optional[str] = Field(None, description="Skill name (if found)")
    error: str = Field(..., description="Error message")


class GitBatchUpdateResponse(BaseModel):
    """Response from batch updating skills from Git repositories"""

    success: List[GitBatchUpdateSuccessItem] = Field(
        default_factory=list, description="Successfully updated skills"
    )
    skipped: List[GitBatchUpdateSkippedItem] = Field(
        default_factory=list,
        description="Skipped skills (not found, not from git, etc.)",
    )
    failed: List[GitBatchUpdateFailedItem] = Field(
        default_factory=list, description="Failed skill updates"
    )
    total_success: int = Field(
        0, description="Total number of successfully updated skills"
    )
    total_skipped: int = Field(0, description="Total number of skipped skills")
    total_failed: int = Field(0, description="Total number of failed updates")
