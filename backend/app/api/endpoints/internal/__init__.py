# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal API endpoints for service-to-service communication."""

from app.core.config import settings

from .bots import router as bots_router
from .callback import router as callback_router
from .chat_storage import router as chat_storage_router
from .object_storage import router as object_storage_router
from .rag_content import router as rag_content_router
from .services import router as services_router
from .skills import router as skills_router
from .subscriptions import router as subscriptions_router
from .tables import router as tables_router
from .workspace_archives import router as workspace_archives_router

# RAG router is conditionally imported based on STANDALONE_MODE
# RAG module is heavy (llama_index, scipy, pandas, grpc) - skip in standalone mode
if not settings.STANDALONE_MODE:
    from .rag import router as rag_router

__all__ = [
    "bots_router",
    "callback_router",
    "chat_storage_router",
    "object_storage_router",
    "rag_content_router",
    "services_router",
    "skills_router",
    "subscriptions_router",
    "tables_router",
    "workspace_archives_router",
]

# Conditionally add rag_router to __all__
if not settings.STANDALONE_MODE:
    __all__.append("rag_router")
