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
from app.models.user import User
from app.services.knowledge.indexing import run_document_indexing
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import RemoteRagGatewayError
from app.tasks.knowledge_tasks import index_document_task
from shared.models import PresignedUrlContentRef
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
    mocker.patch.object(settings, "RAG_RUNTIME_MODE", "remote")
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
    local_index = mocker.patch.object(
        LocalRagGateway,
        "index_document",
        AsyncMock(side_effect=AssertionError("local index must not run")),
    )

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
    local_index.assert_not_called()


def test_remote_index_failure_is_visible_without_local_index(
    test_db: Session, test_user: User, mocker
) -> None:
    kb, document = _prepare_indexable_kb(test_db, test_user)
    mocker.patch.object(settings, "RAG_RUNTIME_MODE", "remote")
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
    local_index = mocker.patch.object(
        LocalRagGateway,
        "index_document",
        AsyncMock(side_effect=AssertionError("local index must not run")),
    )

    with pytest.raises(RemoteRagGatewayError):
        run_document_indexing(**_index_kwargs(kb, document, test_user), db=test_db)

    local_index.assert_not_called()


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
        "app.services.knowledge.indexing.get_index_gateway", return_value=gateway
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
