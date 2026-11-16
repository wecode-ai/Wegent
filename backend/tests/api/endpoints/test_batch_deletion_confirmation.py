# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.resource_member import ResourceMember, ResourceRole
from app.models.user import User
from tests.api.endpoints.test_content_deletion_confirmation import (
    _external_failure,
    deletion_target,
)


@pytest.fixture
def batch_target(
    test_db: Session,
    test_user: User,
    deletion_target: tuple[int, int],
    monkeypatch: pytest.MonkeyPatch,
) -> list[int]:
    monkeypatch.setattr(
        "app.api.knowledge_document_side_effects.SessionLocal",
        sessionmaker(bind=test_db.get_bind()),
    )
    kb_id, first_id = deletion_target
    documents = [
        KnowledgeDocument(
            kind_id=kb_id,
            user_id=test_user.id,
            attachment_id=0,
            name=f"document-{index}",
            source_type="file",
            file_extension="txt",
            status="enabled",
            is_active=True,
        )
        for index in range(1, 4)
    ]
    test_db.add_all(documents)
    test_db.commit()
    return [first_id, *[int(doc.id) for doc in documents]]


@pytest.mark.parametrize(
    "prefix", ["/api/knowledge-documents", "/api/knowledge/documents"]
)
def test_batch_returns_per_item_results_and_only_retries_external_failures(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    batch_target: list[int],
    prefix: str,
) -> None:
    healthy, external, internal, missing_later = batch_target
    requests: list[int] = []

    async def remote(url: str, **kwargs: Any) -> httpx.Response:
        doc_id = int(kwargs["json"]["document_ref"])
        requests.append(doc_id)
        if doc_id == external:
            return _external_failure()
        if doc_id == internal:
            return httpx.Response(
                500, json={"code": "internal_error", "message": "Runtime failed"}
            )
        return httpx.Response(200, json={"status": "deleted"})

    headers = {"Authorization": f"Bearer {test_token}"}
    with patch("httpx.AsyncClient.post", side_effect=remote):
        first = test_client.post(
            f"{prefix}/batch/delete",
            headers=headers,
            params={"include_cleanup_result": True},
            json={
                "document_ids": [healthy, external, internal, healthy, missing_later]
            },
        )
        assert first.status_code == 200, first.text
        data = first.json()
        assert data["success_count"] == 2
        assert data["failed_ids"] == [external, internal]
        assert [item["document_id"] for item in data["items"]] == [
            healthy,
            external,
            internal,
            missing_later,
        ]
        eligible = [
            item["document_id"] for item in data["items"] if item["can_continue"]
        ]
        assert eligible == [external]
        second = test_client.post(
            f"{prefix}/batch/delete",
            headers=headers,
            params={"continue_on_external_engine_failure": True},
            json={"document_ids": eligible},
        )
    assert second.status_code == 200, second.text
    assert second.json()["success_count"] == 1
    assert second.json()["failed_count"] == 0
    assert second.json()["unconfirmed_count"] == 1
    assert requests == [healthy, external, internal, missing_later, external]
    test_db.expire_all()
    assert test_db.get(KnowledgeDocument, external) is None
    assert test_db.get(KnowledgeDocument, internal) is not None


def test_commit_failure_rolls_back_before_the_next_document(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    batch_target: list[int],
) -> None:
    from sqlalchemy import event

    bad, good = batch_target[:2]
    name = test_user.user_name
    armed = True

    def poison(session: Session, flush_context: Any, instances: Any) -> None:
        nonlocal armed
        if armed and any(
            isinstance(row, KnowledgeDocument) and row.id == bad
            for row in session.deleted
        ):
            armed = False
            session.add(User(user_name=name, password_hash="unused"))

    event.listen(test_db, "before_flush", poison)
    try:
        with patch(
            "httpx.AsyncClient.post",
            return_value=httpx.Response(200, json={"status": "deleted"}),
        ):
            response = test_client.post(
                "/api/knowledge-documents/batch/delete",
                headers={"Authorization": f"Bearer {test_token}"},
                params={"continue_on_external_engine_failure": True},
                json={"document_ids": [bad, good]},
            )
    finally:
        event.remove(test_db, "before_flush", poison)
    assert response.status_code == 200, response.text
    assert response.json()["success_count"] == 1
    assert response.json()["failed_ids"] == [bad]
    assert response.json()["items"][0]["can_continue"] is False
    test_db.expire_all()
    assert test_db.get(KnowledgeDocument, bad) is not None
    assert test_db.get(KnowledgeDocument, good) is None


def test_real_permission_denial_is_not_in_the_confirmation_subset(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    batch_target: list[int],
) -> None:
    other = User(user_name="other-owner", password_hash="unused")
    test_db.add(other)
    test_db.flush()
    kb = Kind(
        user_id=other.id,
        kind="KnowledgeBase",
        name="shared-readonly",
        namespace="default",
        is_active=True,
        json={"spec": {}},
    )
    test_db.add(kb)
    test_db.flush()
    denied = KnowledgeDocument(
        kind_id=kb.id,
        user_id=other.id,
        attachment_id=0,
        name="readonly",
        source_type="file",
        file_extension="txt",
        status="enabled",
        is_active=True,
    )
    test_db.add_all(
        [
            denied,
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=kb.id,
                entity_type="user",
                entity_id=str(test_user.id),
                role=ResourceRole.Reporter.value,
                status="approved",
                invited_by_user_id=other.id,
                share_link_id=0,
                reviewed_by_user_id=other.id,
                copied_resource_id=0,
            ),
        ]
    )
    test_db.commit()
    denied_id = int(denied.id)
    with patch("httpx.AsyncClient.post", return_value=_external_failure()) as remote:
        response = test_client.post(
            "/api/knowledge-documents/batch/delete",
            headers={"Authorization": f"Bearer {test_token}"},
            params={"include_cleanup_result": True},
            json={"document_ids": [batch_target[0], denied_id]},
        )
    assert response.status_code == 200, response.text
    assert remote.call_count == 1
    items = response.json()["items"]
    assert [item["document_id"] for item in items if item["can_continue"]] == [
        batch_target[0]
    ]
    assert items[1]["error_code"] == "deletion_rejected"
    assert items[1]["content_deleted"] is False


@pytest.mark.parametrize("failure_kind", ["permission", "internal", "unknown"])
def test_confirmation_revalidates_permission_and_failure_source(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    batch_target: list[int],
    failure_kind: str,
) -> None:
    first_id = batch_target[0]
    headers = {"Authorization": f"Bearer {test_token}"}
    url = "/api/knowledge-documents/batch/delete"
    with patch("httpx.AsyncClient.post", return_value=_external_failure()):
        first = test_client.post(
            url,
            headers=headers,
            params={"include_cleanup_result": True},
            json={"document_ids": [first_id]},
        )
    assert first.json()["items"][0]["can_continue"] is True
    if failure_kind == "permission":
        other = User(user_name="replacement-owner", password_hash="unused")
        test_db.add(other)
        test_db.flush()
        doc = test_db.get(KnowledgeDocument, first_id)
        test_db.get(Kind, doc.kind_id).user_id = other.id
        doc.user_id = other.id
        test_db.commit()
    with patch(
        "httpx.AsyncClient.post",
        return_value=httpx.Response(
            500, json={"code": "internal_error", "message": "failed"}
        ),
        side_effect=(
            httpx.ReadTimeout("unconfirmed Runtime failure")
            if failure_kind == "unknown"
            else None
        ),
    ) as remote:
        second = test_client.post(
            url,
            headers=headers,
            params={"continue_on_external_engine_failure": True},
            json={"document_ids": [first_id]},
        )
    assert second.status_code == 200, second.text
    assert second.json()["success_count"] == 0
    assert second.json()["items"][0]["can_continue"] is False
    if failure_kind == "permission":
        remote.assert_not_called()
    assert test_db.get(KnowledgeDocument, first_id) is not None


def test_batch_confirmation_reports_recovered_cleanup_as_confirmed(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    batch_target: list[int],
) -> None:
    doc_id = batch_target[0]
    url = "/api/knowledge-documents/batch/delete"
    headers = {"Authorization": f"Bearer {test_token}"}
    with patch(
        "httpx.AsyncClient.post",
        side_effect=[
            _external_failure(),
            httpx.Response(200, json={"status": "deleted"}),
        ],
    ) as remote:
        first = test_client.post(
            url,
            headers=headers,
            params={"include_cleanup_result": True},
            json={"document_ids": [doc_id]},
        )
        assert first.json()["items"][0]["can_continue"] is True
        second = test_client.post(
            url,
            headers=headers,
            params={"continue_on_external_engine_failure": True},
            json={"document_ids": [doc_id]},
        )
    assert remote.call_count == 2
    assert second.json()["success_count"] == 1
    assert second.json()["unconfirmed_count"] == 0
    assert second.json()["items"][0]["index_cleanup"] == "confirmed"
    assert second.json()["items"][0]["error_code"] is None
