# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from app.core.config import settings
from app.services.rag.gateway import RagGateway
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import RemoteRagGateway
from shared.telemetry.decorators import trace_sync


def _build_gateway(mode: str) -> RagGateway:
    normalized_mode = mode.strip().lower()
    if normalized_mode == "remote":
        return RemoteRagGateway()
    return LocalRagGateway()


def get_index_gateway() -> RagGateway:
    return _build_gateway(settings.get_rag_runtime_mode("index"))


def get_query_gateway() -> RagGateway:
    return _build_gateway(settings.get_rag_runtime_mode("query"))


def get_delete_gateway() -> RagGateway:
    return _build_gateway(settings.get_rag_runtime_mode("delete"))


@trace_sync("rag.get_list_chunks_gateway")
def get_list_chunks_gateway() -> RagGateway:
    """Return the appropriate RagGateway (local or remote) based on the 'list_chunks' runtime mode."""
    return _build_gateway(settings.get_rag_runtime_mode("list_chunks"))
