# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from app.services.rag.gateway import RagGateway
from app.services.rag.remote_gateway import RemoteRagGateway

_gateway_instance: RemoteRagGateway | None = None


def _get_gateway() -> RemoteRagGateway:
    """Get or create the singleton RemoteRagGateway instance."""
    global _gateway_instance
    if _gateway_instance is None:
        _gateway_instance = RemoteRagGateway()
    return _gateway_instance


def get_index_gateway() -> RagGateway:
    """Get gateway for indexing operations."""
    return _get_gateway()


def get_query_gateway() -> RagGateway:
    """Get gateway for query operations."""
    return _get_gateway()


def get_delete_gateway() -> RagGateway:
    """Get gateway for delete operations."""
    return _get_gateway()


def get_list_chunks_gateway() -> RagGateway:
    """Get gateway for list chunks operations."""
    return _get_gateway()
