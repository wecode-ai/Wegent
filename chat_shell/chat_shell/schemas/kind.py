# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kubernetes-style API schemas for cloud-native agent management.

This is a subset of the full kind.py schemas, containing only what's needed
for the Chat Shell service.
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


# Model Category Type Enum
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


class ObjectMeta(BaseModel):
    """Standard Kubernetes object metadata"""

    name: str
    namespace: str = "default"
    displayName: Optional[str] = None
    labels: Optional[Dict[str, str]] = None


class Status(BaseModel):
    """Standard status object"""

    state: str
    message: Optional[str] = None


# Ghost CRD schemas
class GhostSpec(BaseModel):
    """Ghost specification"""

    systemPrompt: str
    mcpServers: Optional[Dict[str, Any]] = None
    skills: Optional[List[str]] = None


class GhostStatus(Status):
    """Ghost status"""

    state: str = "Available"


class Ghost(BaseModel):
    """Ghost CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Ghost"
    metadata: ObjectMeta
    spec: GhostSpec
    status: Optional[GhostStatus] = None


# Model CRD schemas
class ModelSpec(BaseModel):
    """Model specification"""

    modelConfig: Dict[str, Any]
    isCustomConfig: Optional[bool] = None
    protocol: Optional[str] = None
    apiFormat: Optional[ApiFormat] = None
    contextWindow: Optional[int] = None
    maxOutputTokens: Optional[int] = None
    modelType: Optional[ModelCategoryType] = ModelCategoryType.LLM


class ModelStatus(Status):
    """Model status"""

    state: str = "Available"


class Model(BaseModel):
    """Model CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Model"
    metadata: ObjectMeta
    spec: ModelSpec
    status: Optional[ModelStatus] = None


# Skill CRD schemas
class SkillToolDeclaration(BaseModel):
    """Tool declaration in skill configuration."""

    name: str = Field(..., description="Tool name")
    provider: str = Field(..., description="Provider name")
    config: Optional[Dict[str, Any]] = Field(
        None, description="Tool-specific configuration"
    )


class SkillProviderConfig(BaseModel):
    """Provider configuration for dynamic loading from skill"""

    module: str = Field(
        "provider",
        description="Module name (without .py extension)",
    )
    class_name: str = Field(
        ...,
        alias="class",
        description="Provider class name",
    )


class SkillSpec(BaseModel):
    """Skill specification"""

    description: str
    displayName: Optional[str] = None
    prompt: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None
    bindShells: Optional[List[str]] = None
    tools: Optional[List[SkillToolDeclaration]] = None
    provider: Optional[SkillProviderConfig] = None


class SkillStatus(Status):
    """Skill status"""

    state: str = "Available"
    fileSize: Optional[int] = None
    fileHash: Optional[str] = None


class Skill(BaseModel):
    """Skill CRD"""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Skill"
    metadata: ObjectMeta
    spec: SkillSpec
    status: Optional[SkillStatus] = None
