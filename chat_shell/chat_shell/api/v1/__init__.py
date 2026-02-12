"""
API v1 module for chat_shell.
"""

from chat_shell.api.v1.schemas import (  # Request schemas
    AttachmentConfig,
    CancelRequest,
    CancelResponse,
    FeaturesConfig,
    HealthResponse,
    InputConfig,
    KnowledgeContext,
    Metadata,
    ModelConfig,
    ResponseRequest,
    ResponsesAPIStreamEvents,
    ResponsesAPIStreamingResponse,
    ToolsConfig,
)

__all__ = [
    # Request schemas
    "ResponseRequest",
    "ModelConfig",
    "InputConfig",
    "ToolsConfig",
    "FeaturesConfig",
    "Metadata",
    "AttachmentConfig",
    "KnowledgeContext",
    # OpenAI Responses API types
    "ResponsesAPIStreamEvents",
    "ResponsesAPIStreamingResponse",
    # Other
    "CancelRequest",
    "CancelResponse",
    "HealthResponse",
]
