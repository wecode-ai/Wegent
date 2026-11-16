# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from shared.knowledge_cleanup import EXTERNAL_CLEANUP_ERROR


@pytest.fixture
def deletion_target(test_db: Session, test_user: User) -> tuple[int, int]:
    retriever = Kind(
        user_id=test_user.id,
        kind="Retriever",
        name="cleanup-retriever",
        namespace="default",
        is_active=True,
        json={
            "metadata": {"name": "cleanup-retriever", "namespace": "default"},
            "spec": {
                "storageConfig": {
                    "type": "qdrant",
                    "url": "http://qdrant:6333",
                    "indexStrategy": {"mode": "per_dataset"},
                }
            },
        },
    )
    kb = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="cleanup-kb",
        namespace="default",
        is_active=True,
        json={"spec": {"retrievalConfig": {"retriever_name": "cleanup-retriever"}}},
    )
    test_db.add_all([retriever, kb])
    test_db.flush()
    doc = KnowledgeDocument(
        kind_id=kb.id,
        user_id=test_user.id,
        attachment_id=0,
        name="document",
        source_type="file",
        file_extension="txt",
        status="enabled",
        is_active=True,
    )
    test_db.add(doc)
    test_db.commit()
    return kb.id, doc.id


def _external_failure() -> httpx.Response:
    return httpx.Response(
        502,
        json={
            "code": EXTERNAL_CLEANUP_ERROR,
            "message": "External index cleanup could not be confirmed",
            "retryable": True,
            "details": {
                "stage": "external_index_cleanup",
                "storage_type": "qdrant",
                "reason": "connection_failed",
            },
        },
    )


@pytest.mark.parametrize(
    "prefix", ["/api/knowledge-documents", "/api/knowledge/documents"]
)
def test_document_confirmation_retries_and_reports_residuals(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    deletion_target: tuple[int, int],
    prefix: str,
) -> None:
    _, doc_id = deletion_target
    url = f"{prefix}/{doc_id}"
    headers = {"Authorization": f"Bearer {test_token}"}
    with patch("httpx.AsyncClient.post", return_value=_external_failure()) as request:
        first = test_client.delete(url, headers=headers)
        assert first.status_code == 502
        assert first.json()["detail"]["can_continue"] is True
        assert test_db.get(KnowledgeDocument, doc_id) is not None
        continued = test_client.delete(
            url,
            headers=headers,
            params={
                "continue_on_external_engine_failure": True,
                "include_cleanup_result": True,
            },
        )
        assert request.call_count == 2
    assert continued.status_code == 200, continued.text
    assert continued.json() == {
        "content_deleted": True,
        "index_cleanup": "unconfirmed",
        "error_code": EXTERNAL_CLEANUP_ERROR,
        "can_continue": False,
    }
    test_db.expire_all()
    assert test_db.get(KnowledgeDocument, doc_id) is None


@pytest.mark.parametrize(
    "code,status,details",
    [
        ("internal_error", 500, None),
        ("authorization_required", 403, None),
        (EXTERNAL_CLEANUP_ERROR, 502, None),
        (
            EXTERNAL_CLEANUP_ERROR,
            502,
            {"stage": "wrong", "reason": "timeout", "storage_type": "qdrant"},
        ),
    ],
)
def test_confirmation_cannot_bypass_internal_or_ambiguous_failure(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    deletion_target: tuple[int, int],
    code: str,
    status: int,
    details: dict[str, Any] | None,
) -> None:
    _, doc_id = deletion_target
    with patch(
        "httpx.AsyncClient.post",
        return_value=httpx.Response(
            status,
            json={
                "code": code,
                "message": "cleanup failed",
                "retryable": True,
                "details": details,
            },
        ),
    ):
        response = test_client.delete(
            f"/api/knowledge-documents/{doc_id}",
            headers={"Authorization": f"Bearer {test_token}"},
            params={
                "continue_on_external_engine_failure": True,
                "include_cleanup_result": True,
            },
        )
    assert response.status_code == status
    assert "can_continue" not in response.json()
    assert test_db.get(KnowledgeDocument, doc_id) is not None


@pytest.mark.parametrize("code_wiki", [False, True])
def test_knowledge_base_confirmation_reports_cleanup_independently(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    deletion_target: tuple[int, int],
    code_wiki: bool,
) -> None:
    from sqlalchemy.orm.attributes import flag_modified

    kb_id, doc_id = deletion_target
    if code_wiki:
        kb = test_db.get(Kind, kb_id)
        kb.json["spec"]["kbType"] = "code_wiki"
        flag_modified(kb, "json")
        test_db.get(KnowledgeDocument, doc_id).origin = "generated"
    else:
        test_db.delete(test_db.get(KnowledgeDocument, doc_id))
    test_db.commit()
    with patch("httpx.AsyncClient.post", return_value=_external_failure()) as request:
        first = test_client.delete(
            f"/api/knowledge-bases/{kb_id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert first.status_code == 502
        assert first.json()["detail"]["can_continue"] is True
        response = test_client.delete(
            f"/api/knowledge-bases/{kb_id}",
            headers={"Authorization": f"Bearer {test_token}"},
            params={
                "continue_on_external_engine_failure": True,
                "include_cleanup_result": True,
            },
        )
        assert request.call_count == 2
    assert response.status_code == 200, response.text
    assert response.json()["content_deleted"] is True
    assert response.json()["index_cleanup"] == "unconfirmed"
    test_db.expire_all()
    assert test_db.get(Kind, kb_id) is None


def test_external_recovery_is_cleaned_and_legacy_success_stays_204(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    deletion_target: tuple[int, int],
) -> None:
    _, doc_id = deletion_target
    with patch(
        "httpx.AsyncClient.post",
        side_effect=[
            _external_failure(),
            httpx.Response(200, json={"status": "deleted"}),
        ],
    ) as request:
        url = f"/api/knowledge-documents/{doc_id}"
        headers = {"Authorization": f"Bearer {test_token}"}
        assert test_client.delete(url, headers=headers).status_code == 502
        response = test_client.delete(
            url,
            headers=headers,
            params={
                "continue_on_external_engine_failure": True,
                "include_cleanup_result": True,
            },
        )
        assert request.call_count == 2
    assert response.json()["index_cleanup"] == "confirmed"
    assert response.json()["error_code"] is None


def test_ordinary_nonempty_knowledge_base_cannot_be_forced(
    test_client: TestClient, test_token: str, deletion_target: tuple[int, int]
) -> None:
    kb_id, _ = deletion_target
    with patch("httpx.AsyncClient.post") as request:
        response = test_client.delete(
            f"/api/knowledge-bases/{kb_id}",
            headers={"Authorization": f"Bearer {test_token}"},
            params={"continue_on_external_engine_failure": True},
        )
    assert response.status_code == 403
    request.assert_not_called()


def test_permission_is_checked_again_before_continuing(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    deletion_target: tuple[int, int],
) -> None:
    from app.models.user import User

    kb_id, doc_id = deletion_target
    url = f"/api/knowledge-documents/{doc_id}"
    headers = {"Authorization": f"Bearer {test_token}"}
    with patch("httpx.AsyncClient.post", return_value=_external_failure()) as request:
        assert test_client.delete(url, headers=headers).status_code == 502
        other = User(user_name="new-owner", password_hash="unused")
        test_db.add(other)
        test_db.flush()
        test_db.get(Kind, kb_id).user_id = other.id
        test_db.get(KnowledgeDocument, doc_id).user_id = other.id
        test_db.commit()
        response = test_client.delete(
            url, headers=headers, params={"continue_on_external_engine_failure": True}
        )
        assert response.status_code in {403, 404}
        assert request.call_count == 1
    assert test_db.get(KnowledgeDocument, doc_id) is not None


def test_gateway_transport_error_is_not_an_external_engine_verdict(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    deletion_target: tuple[int, int],
) -> None:
    _, doc_id = deletion_target
    with patch(
        "httpx.AsyncClient.post",
        side_effect=httpx.ConnectError("Runtime connection failed"),
    ):
        response = test_client.delete(
            f"/api/knowledge-documents/{doc_id}",
            headers={"Authorization": f"Bearer {test_token}"},
            params={"continue_on_external_engine_failure": True},
        )
    assert response.status_code == 502
    assert isinstance(response.json()["detail"], str)
    assert test_db.get(KnowledgeDocument, doc_id) is not None


def test_runtime_authentication_failure_is_not_a_caller_login_failure(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    deletion_target: tuple[int, int],
) -> None:
    _, doc_id = deletion_target
    with patch(
        "httpx.AsyncClient.post",
        return_value=httpx.Response(
            401, json={"detail": "Invalid authentication token"}
        ),
    ):
        response = test_client.delete(
            f"/api/knowledge-documents/{doc_id}",
            headers={"Authorization": f"Bearer {test_token}"},
            params={"continue_on_external_engine_failure": True},
        )
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "cleanup_service_authentication_failed"
    assert response.json()["detail"]["can_continue"] is False
    assert test_db.get(KnowledgeDocument, doc_id) is not None


def test_broken_configuration_does_not_skip_cleanup(
    test_db: Session, test_user: User, deletion_target: tuple[int, int]
) -> None:
    from sqlalchemy.orm.attributes import flag_modified

    from app.services.knowledge.knowledge_service import KnowledgeService

    kb_id, doc_id = deletion_target
    kb = test_db.get(Kind, kb_id)
    kb.json["spec"]["retrievalConfig"] = {}
    flag_modified(kb, "json")
    test_db.commit()
    with patch("httpx.AsyncClient.post") as request:
        with pytest.raises(RuntimeError, match="configuration is incomplete"):
            KnowledgeService.delete_document(
                test_db, doc_id, test_user.id, continue_on_external_engine_failure=True
            )
    request.assert_not_called()
    assert test_db.get(KnowledgeDocument, doc_id) is not None


def test_commit_failure_never_returns_content_deleted(
    test_db: Session, test_user: User, deletion_target: tuple[int, int]
) -> None:
    from sqlalchemy.exc import SQLAlchemyError

    from app.services.knowledge.knowledge_service import KnowledgeService

    _, doc_id = deletion_target
    with patch(
        "httpx.AsyncClient.post",
        return_value=httpx.Response(200, json={"status": "deleted"}),
    ):
        with patch.object(
            test_db, "commit", side_effect=SQLAlchemyError("commit failed")
        ):
            with pytest.raises(SQLAlchemyError):
                KnowledgeService.delete_document(
                    test_db,
                    doc_id,
                    test_user.id,
                    continue_on_external_engine_failure=True,
                )
    test_db.rollback()
    assert test_db.get(KnowledgeDocument, doc_id) is not None
