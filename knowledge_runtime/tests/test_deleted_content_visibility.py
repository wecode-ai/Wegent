# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read visibility with real persisted documents and a residual external index."""

import asyncio
from threading import Event
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session, sessionmaker

from knowledge_runtime.models.knowledge_document import KnowledgeDocument
from knowledge_runtime.services.admin_executor import AdminExecutor
from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.config_resolver import ConfigResolutionError
from knowledge_runtime.services.query_executor import QueryExecutor
from shared.models import (
    RemoteAuthorizedIndexResources,
    RemoteAuthorizedRetrievalResources,
    RemoteListChunksRequest,
    RemoteQueryRequest,
    RemoteRetrievalResourceRef,
    RetrievalScope,
)
from shared.models.db import Kind


def _chunk(document_ref: str, knowledge_id: str = "1") -> dict:
    return {
        "content": f"body-{knowledge_id}-{document_ref}",
        "doc_ref": document_ref,
        "metadata": {"knowledge_id": knowledge_id, "doc_ref": document_ref},
    }


@pytest.fixture
def listing(shared_model_db: Session) -> tuple:
    shared_model_db.add_all(
        [
            KnowledgeDocument(id=11, kind_id=1, status="enabled", is_active=True),
            KnowledgeDocument(id=12, kind_id=1, status="disabled", is_active=False),
            KnowledgeDocument(id=21, kind_id=99, status="enabled", is_active=True),
        ]
    )
    shared_model_db.commit()
    loader = RuntimeConfigLoader(
        session_factory=sessionmaker(bind=shared_model_db.get_bind())
    )
    request = RemoteListChunksRequest(
        knowledge_base_id=1,
        user_id=42,
        authorized_resources=RemoteAuthorizedIndexResources(
            operation="list_chunks",
            knowledge_base_id=1,
            index_owner_user_id=42,
            retriever=RemoteRetrievalResourceRef(
                kind="Retriever", name="test-retriever", namespace="default"
            ),
        ),
    )
    storage = MagicMock()
    storage.extract_chunk_text.side_effect = lambda text: text
    storage.get_all_chunks.return_value = [
        _chunk("11"),
        _chunk("doc_12"),
        _chunk("21"),
        _chunk("11", "99"),
        _chunk("unknown"),
        {"content": "unattributed body", "doc_ref": "11", "metadata": {}},
    ]
    return loader, request, storage


@pytest.mark.asyncio
async def test_chunk_listing_hides_deleted_and_foreign_documents(
    shared_model_db: Session, listing: tuple
) -> None:
    loader, request, storage = listing
    executor = AdminExecutor(config_loader=loader)
    with patch(
        "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
        return_value=storage,
    ):
        before = await executor.list_chunks(request)
        assert [chunk.content for chunk in before.chunks] == [
            "body-1-11",
            "body-1-doc_12",
        ]
        shared_model_db.delete(shared_model_db.get(KnowledgeDocument, 11))
        shared_model_db.commit()

        after = await executor.list_chunks(request)

    assert after.total == 1
    assert [chunk.content for chunk in after.chunks] == ["body-1-doc_12"]


@pytest.mark.asyncio
async def test_in_flight_listing_can_finish_but_new_listing_uses_current_documents(
    shared_model_db: Session, listing: tuple
) -> None:
    loader, request, storage = listing
    executor = AdminExecutor(config_loader=loader)
    started, release = Event(), Event()

    def read_index(**kwargs: object) -> list[dict]:
        started.set()
        assert release.wait(timeout=5), "The in-flight read was not released"
        return [_chunk("11")]

    storage.get_all_chunks.side_effect = read_index
    with patch(
        "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
        return_value=storage,
    ):
        task = asyncio.create_task(executor.list_chunks(request))
        try:
            assert await asyncio.to_thread(started.wait, 5)
            shared_model_db.delete(shared_model_db.get(KnowledgeDocument, 11))
            shared_model_db.commit()
        finally:
            release.set()
        in_flight = await task
        after = await executor.list_chunks(request)

    assert [chunk.content for chunk in in_flight.chunks] == ["body-1-11"]
    assert after.chunks == []
    assert after.total == 0


@pytest.mark.asyncio
async def test_deleted_knowledge_base_cannot_list_residual_chunks(
    shared_model_db: Session, listing: tuple
) -> None:
    loader, request, storage = listing
    executor = AdminExecutor(config_loader=loader)
    shared_model_db.delete(shared_model_db.get(Kind, 1))
    shared_model_db.commit()

    with pytest.raises(ConfigResolutionError, match="not found"):
        await executor.list_chunks(request)

    storage.get_all_chunks.assert_not_called()


@pytest.mark.asyncio
async def test_new_queries_cannot_retrieve_residual_or_late_written_documents(
    shared_model_db: Session, listing: tuple
) -> None:
    loader, request, storage = listing
    executor = QueryExecutor(config_loader=loader)
    query = RemoteQueryRequest(
        knowledge_base_ids=[1],
        user_id=42,
        query="question",
        authorized_resources=[
            RemoteAuthorizedRetrievalResources(
                operation="query",
                knowledge_base_id=1,
                index_owner_user_id=42,
                retriever=request.authorized_resources.retriever,
                embedding_model=RemoteRetrievalResourceRef(
                    kind="Model", name="shared-embedding", namespace="search-team"
                ),
            )
        ],
    )

    def retrieve(*, scope: RetrievalScope, **kwargs: object) -> dict:
        return {
            "records": (
                [{"content": "residual body", "metadata": {"doc_ref": "11"}}]
                if 11 in scope.document_ids
                else []
            )
        }

    storage.retrieve.side_effect = retrieve
    with (
        patch(
            "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
            return_value=storage,
        ),
        patch(
            "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config",
            return_value=object(),
        ),
    ):
        before = await executor.execute(query)
        assert [record.document_id for record in before.records] == [11]
        shared_model_db.delete(shared_model_db.get(KnowledgeDocument, 11))
        shared_model_db.commit()
        after = await executor.execute(query)

    assert after.records == []
    assert after.total == 0
