# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
from pathlib import PurePosixPath
from urllib.parse import urlparse

from knowledge_runtime.services import content_fetcher

from knowledge_engine.embedding import create_embedding_model_from_runtime_config
from knowledge_engine.query import QueryExecutor
from knowledge_engine.services import DocumentService
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from shared.models.knowledge_runtime_protocol import (
    RemoteDeleteDocumentIndexRequest,
    RemoteIndexRequest,
    RemoteQueryRecord,
    RemoteQueryRequest,
    RemoteQueryResponse,
    RemoteTestConnectionRequest,
)


class RuntimeHandlers:
    async def index_document(self, request: RemoteIndexRequest) -> dict:
        content = await content_fetcher.fetch_content(request.content_ref)
        storage_backend = create_storage_backend_from_runtime_config(
            request.retriever_config
        )
        embed_model = create_embedding_model_from_runtime_config(
            request.embedding_model_config
        )
        service = DocumentService(storage_backend=storage_backend)
        source_file, file_extension = self._resolve_source_file_metadata(request)
        return await service.index_document_from_binary(
            knowledge_id=str(request.knowledge_base_id),
            binary_data=content,
            source_file=source_file,
            file_extension=file_extension,
            embed_model=embed_model,
            user_id=request.index_owner_user_id,
            splitter_config=request.splitter_config,
            document_id=request.document_id,
        )

    async def query(self, request: RemoteQueryRequest) -> RemoteQueryResponse:
        metadata_condition = self._combine_metadata_conditions(
            self._build_document_filter(request.document_ids),
            request.metadata_condition,
        )
        records: list[RemoteQueryRecord] = []

        for kb_config in request.knowledge_base_configs:
            storage_backend = create_storage_backend_from_runtime_config(
                kb_config.retriever_config
            )
            embed_model = create_embedding_model_from_runtime_config(
                kb_config.embedding_model_config
            )
            executor = QueryExecutor(
                storage_backend=storage_backend,
                embed_model=embed_model,
            )
            result = await executor.execute(
                knowledge_id=str(kb_config.knowledge_base_id),
                query=request.query,
                retrieval_config=kb_config.retrieval_config,
                metadata_condition=metadata_condition,
                user_id=kb_config.index_owner_user_id,
            )
            records.extend(
                self._build_remote_query_records(
                    knowledge_base_id=kb_config.knowledge_base_id,
                    records=result.get("records", []),
                )
            )

        records.sort(key=lambda item: item.score or 0.0, reverse=True)
        limited_records = records[: request.max_results]
        return RemoteQueryResponse(
            records=limited_records,
            total=len(limited_records),
            total_estimated_tokens=0,
        )

    async def delete_document_index(
        self, request: RemoteDeleteDocumentIndexRequest
    ) -> dict:
        storage_backend = create_storage_backend_from_runtime_config(
            request.retriever_config
        )
        service = DocumentService(storage_backend=storage_backend)
        return await service.delete_document(
            knowledge_id=str(request.knowledge_base_id),
            doc_ref=request.document_ref,
            user_id=request.index_owner_user_id,
        )

    async def test_connection(self, request: RemoteTestConnectionRequest) -> dict:
        storage_backend = create_storage_backend_from_runtime_config(
            request.retriever_config
        )
        success = await asyncio.to_thread(storage_backend.test_connection)
        return {
            "success": success,
            "message": "Connection successful" if success else "Connection failed",
        }

    @staticmethod
    def _build_document_filter(document_ids: list[int] | None) -> dict | None:
        if not document_ids:
            return None

        return {
            "operator": "and",
            "conditions": [
                {
                    "key": "doc_ref",
                    "operator": "in",
                    "value": [str(document_id) for document_id in document_ids],
                }
            ],
        }

    @staticmethod
    def _combine_metadata_conditions(*conditions: dict | None) -> dict | None:
        normalized_conditions = [condition for condition in conditions if condition]
        if not normalized_conditions:
            return None
        if len(normalized_conditions) == 1:
            return normalized_conditions[0]

        return {
            "operator": "and",
            "conditions": normalized_conditions,
        }

    def _build_remote_query_records(
        self,
        *,
        knowledge_base_id: int,
        records: list[dict],
    ) -> list[RemoteQueryRecord]:
        return [
            RemoteQueryRecord(
                content=record.get("content", ""),
                title=record.get("title", "Unknown"),
                score=record.get("score"),
                metadata=record.get("metadata"),
                knowledge_base_id=knowledge_base_id,
                document_id=self._extract_document_id(record.get("metadata")),
                index_family="chunk_vector",
            )
            for record in records
        ]

    @staticmethod
    def _extract_document_id(metadata: dict | None) -> int | None:
        if not isinstance(metadata, dict):
            return None

        doc_ref = metadata.get("doc_ref")
        if isinstance(doc_ref, str) and doc_ref.isdigit():
            return int(doc_ref)
        if isinstance(doc_ref, int):
            return doc_ref
        return None

    @staticmethod
    def _resolve_source_file_metadata(
        request: RemoteIndexRequest,
    ) -> tuple[str, str]:
        parsed_url = urlparse(request.content_ref.url)
        file_name = PurePosixPath(parsed_url.path).name
        if file_name:
            suffix = PurePosixPath(file_name).suffix.lower()
            return file_name, suffix

        fallback_name = f"knowledge-{request.knowledge_base_id}"
        if request.document_id is not None:
            fallback_name = f"document-{request.document_id}"
        return fallback_name, ""


runtime_handlers = RuntimeHandlers()
