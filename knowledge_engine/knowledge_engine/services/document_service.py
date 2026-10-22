# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from pathlib import Path
from typing import Dict

from knowledge_engine.index.indexer import DocumentIndexer
from knowledge_engine.ingestion.pipeline import IngestionPreparation, prepare_ingestion
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from shared.knowledge_module import (
    DocumentChunkMetadata,
    build_document_chunk_metadata,
    finalize_index_result,
)


class DocumentService:
    def __init__(self, storage_backend: BaseStorageBackend):
        self.storage_backend = storage_backend

    async def index_document_from_binary(
        self,
        *,
        knowledge_id: str,
        binary_data: bytes,
        source_file: str,
        file_extension: str,
        embed_model,
        user_id: int,
        splitter_config: dict | None = None,
        document_id: int | None = None,
    ) -> Dict:
        metadata = build_document_chunk_metadata(
            knowledge_id=knowledge_id,
            source_file=source_file,
            document_id=document_id,
        )
        return await self.index_with_metadata(
            metadata=metadata,
            binary_data=binary_data,
            file_extension=file_extension,
            embed_model=embed_model,
            user_id=user_id,
            splitter_config=splitter_config,
        )

    async def index_document_from_file(
        self,
        *,
        knowledge_id: str,
        file_path: str,
        embed_model,
        user_id: int,
        splitter_config: dict | None = None,
        document_id: int | None = None,
    ) -> Dict:
        metadata = build_document_chunk_metadata(
            knowledge_id=knowledge_id,
            source_file=Path(file_path).name,
            document_id=document_id,
        )
        result = await asyncio.to_thread(
            self._index_from_file_sync,
            metadata,
            file_path,
            embed_model,
            user_id,
            splitter_config,
        )
        return finalize_index_result(result, metadata)

    async def index_with_metadata(
        self,
        *,
        metadata: DocumentChunkMetadata,
        binary_data: bytes,
        file_extension: str,
        embed_model,
        user_id: int,
        splitter_config: dict | None = None,
    ) -> Dict:
        """Split, embed and store content under an already-built identity.

        Callers that own the document identity (the reusable module, the remote
        index executor) pass it in; the returned result is normalized with that
        identity, the same shape ``index_document_from_binary`` returns.
        """
        result = await asyncio.to_thread(
            self._index_from_binary_sync,
            metadata,
            binary_data,
            file_extension,
            embed_model,
            user_id,
            splitter_config,
        )
        return finalize_index_result(result, metadata)

    async def delete_document(
        self,
        *,
        knowledge_id: str,
        doc_ref: str,
        user_id: int | None = None,
    ) -> Dict:
        return await asyncio.to_thread(
            self.storage_backend.delete_document,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            user_id=user_id,
        )

    async def list_documents(
        self,
        *,
        knowledge_id: str,
        page: int = 1,
        page_size: int = 20,
        user_id: int | None = None,
    ) -> Dict:
        return await asyncio.to_thread(
            self.storage_backend.list_documents,
            knowledge_id=knowledge_id,
            page=page,
            page_size=page_size,
            user_id=user_id,
        )

    def _index_from_binary_sync(
        self,
        metadata: DocumentChunkMetadata,
        binary_data: bytes,
        file_extension: str,
        embed_model,
        user_id: int,
        splitter_config: dict | None,
    ) -> Dict:
        ingestion_preparation = self._prepare_ingestion(
            splitter_config,
            file_extension=file_extension,
        )
        indexer = DocumentIndexer(
            storage_backend=self.storage_backend,
            embed_model=embed_model,
            splitter_config=ingestion_preparation.normalized_splitter_config.model_dump(
                exclude_none=True
            ),
            file_extension=file_extension,
        )
        return indexer.index_from_binary(
            binary_data=binary_data,
            file_extension=file_extension,
            chunk_metadata=_to_chunk_metadata(metadata),
            user_id=user_id,
        )

    def _index_from_file_sync(
        self,
        metadata: DocumentChunkMetadata,
        file_path: str,
        embed_model,
        user_id: int,
        splitter_config: dict | None,
    ) -> Dict:
        file_extension = Path(file_path).suffix.lower()
        ingestion_preparation = self._prepare_ingestion(
            splitter_config,
            file_extension=file_extension,
        )
        indexer = DocumentIndexer(
            storage_backend=self.storage_backend,
            embed_model=embed_model,
            splitter_config=ingestion_preparation.normalized_splitter_config.model_dump(
                exclude_none=True
            ),
            file_extension=file_extension,
        )
        return indexer.index_document(
            file_path=file_path,
            chunk_metadata=_to_chunk_metadata(metadata),
            user_id=user_id,
        )

    def _prepare_ingestion(
        self,
        splitter_config: dict | None,
        *,
        file_extension: str | None = None,
    ) -> IngestionPreparation:
        return prepare_ingestion(
            splitter_config,
            file_extension=file_extension,
        )


def _to_chunk_metadata(metadata: DocumentChunkMetadata) -> ChunkMetadata:
    """Adapt the module's identity to the indexer's chunk metadata shape."""
    return ChunkMetadata(
        knowledge_id=metadata.knowledge_id,
        doc_ref=metadata.doc_ref,
        source_file=metadata.source_file,
        created_at=metadata.created_at,
    )
