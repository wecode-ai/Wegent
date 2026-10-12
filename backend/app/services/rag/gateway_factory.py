# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from app.services.rag.gateway import RagGateway
from app.services.rag.remote_gateway import RemoteRagGateway
from shared.telemetry.decorators import trace_sync


@trace_sync("rag.get_rag_gateway")
def get_rag_gateway() -> RagGateway:
    """Return the gateway that executes RAG operations in knowledge_runtime."""
    return RemoteRagGateway()
