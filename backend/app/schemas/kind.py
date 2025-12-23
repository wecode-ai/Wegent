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


class TeamSpec(BaseModel):
    """Team specification"""

    members: List[TeamMember]
    collaborationModel: str  # pipeline、route、coordinate、collaborate
    bind_mode: Optional[List[str]] = None  # ['chat', 'code'] or empty list for none
    description: Optional[str] = None  # Team description
    icon: Optional[str] = None  # Icon ID from preset icon library


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


class TaskSpec(BaseModel):
    """Task specification"""

    title: str
    prompt: str
    teamRef: TeamTaskRef
    workspaceRef: WorkspaceTaskRef
    is_group_chat: bool = False  # Whether this task is a group chat


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
class SkillSpec(BaseModel):
    """Skill specification"""

    description: str  # Extracted from SKILL.md YAML frontmatter
    version: Optional[str] = None  # Skill version
    author: Optional[str] = None  # Author
    tags: Optional[List[str]] = None  # Tags


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

    vector_weight: float = Field(0.7, ge=0.0, le=1.0, description="Weight for vector search (0.0-1.0)")
    keyword_weight: float = Field(0.3, ge=0.0, le=1.0, description="Weight for keyword search (0.0-1.0)")

    def model_post_init(self, __context):
        """Validate that weights sum to 1.0"""
        total = self.vector_weight + self.keyword_weight
        if not (0.99 <= total <= 1.01):  # Allow small floating point errors
            raise ValueError(f"Weights must sum to 1.0, got {total}")


class RetrievalConfig(BaseModel):
    """Retrieval configuration for knowledge base"""

    retriever_name: str = Field(..., description="Retriever name")
    retriever_namespace: str = Field("default", description="Retriever namespace")
    embedding_config: EmbeddingModelRef = Field(..., description="Embedding model configuration")
    retrieval_mode: str = Field("vector", description="Retrieval mode: 'vector', 'keyword', or 'hybrid'")
    top_k: int = Field(5, ge=1, le=10, description="Number of results to return")
    score_threshold: float = Field(0.7, ge=0.0, le=1.0, description="Minimum score threshold")
    hybrid_weights: Optional[HybridWeights] = Field(None, description="Hybrid search weights")


class KnowledgeBaseSpec(BaseModel):
    """KnowledgeBase specification"""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    document_count: Optional[int] = Field(
        default=0, description="Cached document count"
    )
    retrievalConfig: Optional[RetrievalConfig] = Field(None, description="Retrieval configuration")


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
