# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for the plain-document remote index closure.

The document create/rebuild entry must reach knowledge_runtime with the
retrieval resources Backend authorized for the knowledge base owner. Any local
index call fails the test, remote failures stay visible, and a stale indexing
generation never overwrites a newer result.
"""

from __future__ import annotations

from contextlib import contextmanager, nullcontext
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.schemas.knowledge import KnowledgeDocumentCreate
from app.services.context import context_service
from app.services.knowledge import search_execution
from app.services.knowledge.indexing import run_document_indexing
from app.services.knowledge.orchestrator import knowledge_orchestrator
from app.services.rag import direct_injection
from app.services.rag.remote_gateway import RemoteRagGateway, RemoteRagGatewayError
from app.tasks.knowledge_tasks import index_document_task
from shared.models import PresignedUrlContentRef, RemoteIndexRequest, RetrievalScope
from tests.utils.remote_only import reject_local_rag_imports  # noqa: F401
from tests.utils.retrieval_resources import embedding_model_kind
from tests.utils.retrieval_resources import retriever_kind as build_retriever_kind


@contextmanager
def _lock_context(acquired: bool):
    yield acquired


@contextmanager
def _task_request_context(*, retries: int = 0):
    index_document_task.push_request(id="task-1", retries=retries, hostname="worker")
    try:
        yield
    finally:
        index_document_task.pop_request()


def _response(url: str, *, status_code: int, json_body: dict) -> httpx.Response:
    return httpx.Response(
        status_code, json=json_body, request=httpx.Request("POST", url)
    )


def _create_knowledge_base(db: Session, user: User) -> Kind:
    kb = Kind(
        user_id=user.id,
        kind="KnowledgeBase",
        name="plain-doc-remote-kb",
        namespace="default",
        json={
            "spec": {
                "name": "plain-doc-remote-kb",
                "retrievalConfig": {
                    "retriever_name": "retriever-a",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "embedding-a",
                        "model_namespace": "default",
                    },
                },
            }
        },
        is_active=True,
    )
    db.add(kb)
    db.commit()
    db.refresh(kb)
    return kb


def _create_document(
    db: Session,
    user: User,
    kb: Kind,
    *,
    index_status: DocumentIndexStatus = DocumentIndexStatus.NOT_INDEXED,
    index_generation: int = 0,
) -> KnowledgeDocument:
    document = KnowledgeDocument(
        kind_id=kb.id,
        attachment_id=23,
        name="release-notes",
        file_extension="md",
        file_size=128,
        status="enabled",
        user_id=user.id,
        is_active=True,
        source_type="file",
        index_status=index_status,
        index_generation=index_generation,
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


def _prepare_indexable_kb(db: Session, user: User) -> tuple[Kind, KnowledgeDocument]:
    db.add(build_retriever_kind(user.id, "retriever-a"))
    db.add(embedding_model_kind(user.id, "embedding-a"))
    db.commit()
    kb = _create_knowledge_base(db, user)
    document = _create_document(db, user, kb)
    return kb, document


def _index_kwargs(kb: Kind, document: KnowledgeDocument, user: User) -> dict[str, Any]:
    return {
        "knowledge_base_id": str(kb.id),
        "attachment_id": document.attachment_id,
        "retriever_name": "retriever-a",
        "retriever_namespace": "default",
        "embedding_model_name": "embedding-a",
        "embedding_model_namespace": "default",
        "user_id": user.id,
        "user_name": user.user_name,
        "document_id": document.id,
        "trigger_summary": False,
    }


def _patch_remote_request(mocker: Any, *, index_status_code: int = 200) -> MagicMock:
    """Patch the runtime POST and return the recorded mock."""
    delete_path = "/internal/rag/delete-document-index"
    index_path = "/internal/rag/index"

    def _post(*args: Any, **kwargs: Any) -> httpx.Response:
        url = args[0]
        if url.endswith(delete_path):
            return _response(url, status_code=200, json_body={"deleted_chunks": 0})
        assert url.endswith(index_path)
        assert kwargs["json"]["knowledge_base_id"]
        if index_status_code >= 400:
            return _response(
                url,
                status_code=index_status_code,
                json_body={
                    "code": "runtime_unavailable",
                    "message": "knowledge runtime unavailable",
                    "retryable": True,
                },
            )
        return _response(
            url, status_code=200, json_body={"status": "success", "indexed_count": 1}
        )

    return mocker.patch("httpx.AsyncClient.post", side_effect=_post)


def test_document_index_request_reaches_runtime_with_authorized_resources(
    test_db: Session, test_user: User, mocker
) -> None:
    kb, document = _prepare_indexable_kb(test_db, test_user)
    mocker.patch(
        "app.services.rag.remote_gateway.SessionLocal", return_value=MagicMock()
    )
    mocker.patch(
        "app.services.rag.remote_gateway.build_content_ref_for_attachment",
        return_value=PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/release-notes.md",
        ),
    )
    mocker.patch(
        "app.services.rag.remote_gateway._get_attachment_source_metadata",
        return_value=("release-notes.md", ".md"),
    )
    post = _patch_remote_request(mocker)

    result = run_document_indexing(**_index_kwargs(kb, document, test_user), db=test_db)

    assert result["status"] == "success"
    index_calls = [
        call
        for call in post.await_args_list
        if call.args[0].endswith("/internal/rag/index")
    ]
    assert len(index_calls) == 1
    # Rebuild order: the stale index is deleted from the runtime before the
    # new generation is written, so the newest content wins.
    paths = [call.args[0] for call in post.await_args_list]
    delete_position = next(
        i
        for i, path in enumerate(paths)
        if path.endswith("/internal/rag/delete-document-index")
    )
    index_position = next(
        i for i, path in enumerate(paths) if path.endswith("/internal/rag/index")
    )
    assert delete_position < index_position
    body = index_calls[0].kwargs["json"]
    assert body["knowledge_base_id"] == kb.id
    assert body["document_id"] == document.id
    assert body["authorized_resources"] == {
        "knowledge_base_id": kb.id,
        "index_owner_user_id": test_user.id,
        "operation": "index",
        "retriever": {
            "kind": "Retriever",
            "name": "retriever-a",
            "namespace": "default",
        },
        "embedding_model": {
            "kind": "Model",
            "name": "embedding-a",
            "namespace": "default",
        },
        "explicit_selection": False,
    }


def test_remote_index_failure_is_visible_without_local_index(
    test_db: Session, test_user: User, mocker
) -> None:
    kb, document = _prepare_indexable_kb(test_db, test_user)
    mocker.patch(
        "app.services.rag.remote_gateway.SessionLocal", return_value=MagicMock()
    )
    mocker.patch(
        "app.services.rag.remote_gateway.build_content_ref_for_attachment",
        return_value=PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/release-notes.md",
        ),
    )
    mocker.patch(
        "app.services.rag.remote_gateway._get_attachment_source_metadata",
        return_value=("release-notes.md", ".md"),
    )
    _patch_remote_request(mocker, index_status_code=503)

    with pytest.raises(RemoteRagGatewayError):
        run_document_indexing(**_index_kwargs(kb, document, test_user), db=test_db)


def test_stale_generation_task_never_reaches_the_index_gateway(
    test_db: Session, test_user: User, mocker, monkeypatch
) -> None:
    """An older generation cannot overwrite the newer indexing result."""
    kb, document = _prepare_indexable_kb(test_db, test_user)
    document.index_status = DocumentIndexStatus.SUCCESS
    document.index_generation = 2
    test_db.commit()

    gateway = MagicMock()
    gateway.index_document = AsyncMock(
        side_effect=AssertionError("stale generation must not write")
    )
    get_gateway = mocker.patch(
        "app.services.knowledge.indexing.get_rag_gateway", return_value=gateway
    )
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.distributed_lock.acquire_watchdog_context",
        lambda *args, **kwargs: _lock_context(True),
    )
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.SessionLocal",
        lambda: nullcontext(test_db),
    )

    with _task_request_context():
        result = index_document_task.run(
            **(_index_kwargs(kb, document, test_user) | {"index_generation": 1})
        )

    assert result["status"] == "skipped"
    assert result["reason"] == "stale_generation"
    get_gateway.assert_not_called()
    gateway.index_document.assert_not_called()
    test_db.refresh(document)
    assert document.index_generation == 2
    assert document.index_status == DocumentIndexStatus.SUCCESS


def test_create_and_rebuild_entries_drive_the_remote_index_request(
    test_db: Session, test_user: User, mocker
) -> None:
    """Create and rebuild entries enqueue generations the runtime consumes.

    The chain is: product entry -> Celery task parameters -> the request the
    task sends -> the runtime request model. ``knowledge_runtime`` consumes that
    same model in its own handling test; the two services share the wire
    contract, not a process.
    """
    kb, _ = _prepare_indexable_kb(test_db, test_user)
    source = SubtaskContext(
        id=23,
        user_id=test_user.id,
        subtask_id=0,
        context_type="attachment",
        name="release-notes.md",
        status="ready",
        type_data={
            "storage_key": "source",
            "storage_backend": "mysql",
            "original_filename": "release-notes.md",
            "file_extension": "md",
            "mime_type": "text/markdown",
            "file_size": 128,
        },
    )
    test_db.add(source)
    test_db.commit()
    storage = MagicMock(backend_type="mysql")
    storage.get.return_value = b"release notes"
    mocker.patch.dict(
        context_service.get_attachment_binary_data.__globals__,
        {"get_storage_backend": lambda db: storage},
    )
    dispatched: list[dict[str, Any]] = []

    def _capture(**kwargs: Any) -> MagicMock:
        dispatched.append(kwargs)
        return MagicMock(id=f"task-{len(dispatched)}")

    mocker.patch(
        "app.tasks.knowledge_tasks.index_document_task.delay",
        side_effect=_capture,
    )

    created = knowledge_orchestrator.create_document_from_attachment(
        db=test_db,
        user=test_user,
        knowledge_base_id=kb.id,
        data=KnowledgeDocumentCreate(
            attachment_id=23,
            name="release-notes",
            file_extension="md",
            file_size=128,
        ),
        trigger_indexing=True,
        trigger_summary=False,
    )
    # The first index finished, so the rebuild entry advances the generation.
    created_row = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == created.id)
        .one()
    )
    created_row.index_status = DocumentIndexStatus.SUCCESS
    test_db.commit()
    rebuilt = knowledge_orchestrator.reindex_document(
        db=test_db,
        user=test_user,
        document_id=created.id,
        trigger_summary=False,
    )

    assert rebuilt["skipped"] is False
    assert rebuilt["index_generation"] == 2
    assert len(dispatched) == 2
    create_task, rebuild_task = dispatched
    assert create_task["index_generation"] == 1
    assert rebuild_task["index_generation"] == 2
    assert rebuild_task["document_id"] == created.id
    assert rebuild_task["knowledge_base_id"] == str(kb.id)
    assert rebuild_task["retriever_name"] == "retriever-a"
    assert rebuild_task["embedding_model_name"] == "embedding-a"
    assert rebuild_task["user_id"] == test_user.id

    mocker.patch(
        "app.services.rag.remote_gateway.SessionLocal", return_value=MagicMock()
    )
    mocker.patch(
        "app.services.rag.remote_gateway.build_content_ref_for_attachment",
        return_value=PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/release-notes.md",
        ),
    )
    mocker.patch(
        "app.services.rag.remote_gateway._get_attachment_source_metadata",
        return_value=("release-notes.md", ".md"),
    )
    post = _patch_remote_request(mocker)

    task_kwargs = {
        key: value for key, value in rebuild_task.items() if key != "index_generation"
    }
    result = run_document_indexing(**task_kwargs, db=test_db)

    assert result["status"] == "success"
    index_calls = [
        call
        for call in post.await_args_list
        if call.args[0].endswith("/internal/rag/index")
    ]
    assert len(index_calls) == 1
    # The payload is the runtime's own request model, so the runtime processor
    # consumes exactly what the task sent.
    request = RemoteIndexRequest.model_validate(index_calls[0].kwargs["json"])
    assert request.knowledge_base_id == kb.id
    assert request.document_id == created.id
    assert request.file_extension == ".md"
    assert request.authorized_resources is not None
    assert request.authorized_resources.knowledge_base_id == kb.id
    assert request.authorized_resources.index_owner_user_id == test_user.id
    assert request.authorized_resources.retriever.name == "retriever-a"
    assert request.authorized_resources.embedding_model.name == "embedding-a"


async def test_product_query_entry_returns_the_indexed_document_reference(
    test_db: Session, test_user: User, mocker, monkeypatch
) -> None:
    """A scoped query from the product entry returns the document reference."""
    kb, document = _prepare_indexable_kb(test_db, test_user)
    monkeypatch.setattr(search_execution, "SessionLocal", lambda: nullcontext(test_db))
    monkeypatch.setattr(
        direct_injection,
        "decide_route_mode_for_chat_shell",
        lambda *args, **kwargs: "rag_retrieval",
    )
    remote_query = mocker.patch.object(
        RemoteRagGateway,
        "query",
        AsyncMock(
            return_value={
                "mode": "rag_retrieval",
                "records": [
                    {
                        "content": "Release checklist",
                        "title": "release-notes",
                        "score": 0.9,
                        "metadata": {"doc_ref": str(document.id)},
                        "knowledge_base_id": kb.id,
                        "document_id": document.id,
                    }
                ],
                "total": 1,
                "total_estimated_tokens": 12,
            }
        ),
    )

    result = await search_execution.knowledge_search_runner.retrieve(
        user_id=test_user.id,
        task_id=None,
        knowledge_base_id=kb.id,
        query="release checklist",
        max_results=10,
        document_ids=[document.id],
        folder_ids=None,
        include_subfolders=True,
        route_mode="rag_retrieval",
        context_window=128000,
        used_context_tokens=0,
        reserved_output_tokens=4096,
        context_buffer_ratio=0.1,
        max_direct_chunks=500,
        search_hints=None,
    )

    spec = remote_query.await_args.args[0]
    assert spec.scope == RetrievalScope(document_ids=[document.id])
    assert spec.authorized_resources[0].knowledge_base_id == kb.id
    assert spec.authorized_resources[0].index_owner_user_id == test_user.id
    assert result["knowledge_base_id"] == kb.id
    assert result["records"][0]["knowledge_base_id"] == kb.id
    assert result["records"][0]["document_id"] == document.id
