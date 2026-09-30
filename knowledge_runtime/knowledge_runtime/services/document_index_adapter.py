# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wegent adapter for the reusable knowledge module's document indexing.

The shared module owns the document identity, chunk metadata and normalized
index result. This adapter supplies what only Wegent can supply for one indexing
call: the storage connection and embedding executor resolved from the knowledge
base's authorized resources.
"""

from __future__ import annotations

from typing import Any, Mapping

from knowledge_engine.services.document_service import DocumentService
from shared.knowledge_module import DocumentChunkMetadata, DocumentIndexRequest


class DocumentServiceIndexAdapter:
    """Index chunks with this runtime's document service for one call."""

    def __init__(self, *, document_service: DocumentService, embed_model: Any) -> None:
        self._document_service = document_service
        self._embed_model = embed_model

    async def index_chunks(
        self, *, metadata: DocumentChunkMetadata, request: DocumentIndexRequest
    ) -> Mapping[str, Any]:
        return await self._document_service.index_with_metadata(
            metadata=metadata,
            binary_data=request.binary_data,
            file_extension=request.file_extension,
            embed_model=self._embed_model,
            user_id=request.user_id,
            splitter_config=request.splitter_config,
        )
