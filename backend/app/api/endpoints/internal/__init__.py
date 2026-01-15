# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal API endpoints for service-to-service communication."""

from .bots import router as bots_router
from .chat_storage import router as chat_storage_router
from .rag import router as rag_router
from .services import router as services_router
from .skills import router as skills_router
from .tables import router as tables_router

__all__ = [
    "bots_router",
    "chat_storage_router",
    "rag_router",
    "services_router",
    "skills_router",
    "tables_router",
]
