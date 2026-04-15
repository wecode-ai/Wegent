# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict

from knowledge_engine.index.indexer import DocumentIndexer
from knowledge_engine.ingestion.pipeline import IngestionPreparation, prepare_ingestion
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata


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
        return await asyncio.to_thread(
            self._index_document_from_binary_sync,
            knowledge_id,
            binary_data,
            source_file,
            file_extension,
            embed_model,
            user_id,
            splitter_config,
            document_id,
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
        return await asyncio.to_thread(
            self._index_document_from_file_sync,
            knowledge_id,
            file_path,
            embed_model,
            user_id,
            splitter_config,
            document_id,
        )

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

    def _index_document_from_binary_sync(
        self,
        knowledge_id: str,
        binary_data: bytes,
        source_file: str,
        file_extension: str,
        embed_model,
        user_id: int,
        splitter_config: dict | None,
        document_id: int | None,
    ) -> Dict:
        ingestion_preparation = self._prepare_ingestion(
            splitter_config,
            file_extension=file_extension,
        )
        chunk_metadata = self._build_chunk_metadata(
            knowledge_id=knowledge_id,
            source_file=source_file,
            document_id=document_id,
        )
        indexer = DocumentIndexer(
            storage_backend=self.storage_backend,
            embed_model=embed_model,
            splitter_config=ingestion_preparation.normalized_splitter_config.model_dump(
                exclude_none=True
            ),
            file_extension=file_extension,
        )
        result = indexer.index_from_binary(
            binary_data=binary_data,
            file_extension=file_extension,
            chunk_metadata=chunk_metadata,
            user_id=user_id,
        )
        return self._finalize_index_result(result, chunk_metadata)

    def _index_document_from_file_sync(
        self,
        knowledge_id: str,
        file_path: str,
        embed_model,
        user_id: int,
        splitter_config: dict | None,
        document_id: int | None,
    ) -> Dict:
        source_file = Path(file_path).name
        file_extension = Path(file_path).suffix.lower()
        ingestion_preparation = self._prepare_ingestion(
            splitter_config,
            file_extension=file_extension,
        )
        chunk_metadata = self._build_chunk_metadata(
            knowledge_id=knowledge_id,
            source_file=source_file,
            document_id=document_id,
        )
        indexer = DocumentIndexer(
            storage_backend=self.storage_backend,
            embed_model=embed_model,
            splitter_config=ingestion_preparation.normalized_splitter_config.model_dump(
                exclude_none=True
            ),
            file_extension=file_extension,
        )
        result = indexer.index_document(
            file_path=file_path,
            chunk_metadata=chunk_metadata,
            user_id=user_id,
        )
        return self._finalize_index_result(result, chunk_metadata)

    def _build_chunk_metadata(
        self,
        *,
        knowledge_id: str,
        source_file: str,
        document_id: int | None,
    ) -> ChunkMetadata:
        doc_ref = (
            str(document_id) if document_id is not None else self._generate_doc_ref()
        )
        return ChunkMetadata(
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            source_file=source_file,
            created_at=datetime.now(timezone.utc).isoformat(),
        )

    def _generate_doc_ref(self) -> str:
        return f"doc_{uuid.uuid4().hex[:12]}"

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

    def _finalize_index_result(
        self,
        result: Dict,
        chunk_metadata: ChunkMetadata,
    ) -> Dict:
        finalized = dict(result)
        finalized.setdefault("doc_ref", chunk_metadata.doc_ref)
        finalized.setdefault("knowledge_id", chunk_metadata.knowledge_id)
        finalized.setdefault("source_file", chunk_metadata.source_file)
        finalized.setdefault("created_at", chunk_metadata.created_at)

        if "chunk_count" not in finalized:
            chunks_data = finalized.get("chunks_data")
            if isinstance(chunks_data, list):
                finalized["chunk_count"] = len(chunks_data)
            elif isinstance(chunks_data, dict):
                finalized["chunk_count"] = chunks_data.get(
                    "total_count",
                    finalized.get("indexed_count", 0),
                )
            else:
                finalized["chunk_count"] = finalized.get("indexed_count", 0)

        return finalized
