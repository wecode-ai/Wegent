# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from knowledge_runtime.services import content_fetcher
from shared.models.knowledge_runtime_protocol import (
    RemoteDeleteDocumentIndexRequest,
    RemoteIndexRequest,
    RemoteQueryRequest,
    RemoteQueryResponse,
)


class RuntimeHandlers:
    async def index_document(self, request: RemoteIndexRequest) -> dict:
        content = await content_fetcher.fetch_content(request.content_ref)
        return {
            "status": "accepted",
            "knowledge_id": str(request.knowledge_base_id),
            "document_id": request.document_id,
            "content_bytes": len(content),
            "content_ref_kind": request.content_ref.kind,
            "index_families": request.index_families,
        }

    async def query(self, request: RemoteQueryRequest) -> RemoteQueryResponse:
        return RemoteQueryResponse(records=[], total=0, total_estimated_tokens=0)

    async def delete_document_index(
        self, request: RemoteDeleteDocumentIndexRequest
    ) -> dict:
        return {
            "status": "accepted",
            "knowledge_id": str(request.knowledge_base_id),
            "doc_ref": request.document_ref,
            "enabled_index_families": request.enabled_index_families,
        }


runtime_handlers = RuntimeHandlers()
