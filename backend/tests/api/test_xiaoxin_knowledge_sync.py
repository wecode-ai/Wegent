# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contract tests for the Xiaoxin fixed-target notification endpoint."""

import logging
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import app.tasks.knowledge_tasks as knowledge_tasks_module
from app.core.config import Settings, settings
from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.services.knowledge.external_document_import import run_external_document_import
from app.services.knowledge.external_document_providers import (
    ExternalDocumentFetchError,
    get_external_document_provider,
)
from app.services.knowledge.xiaoxin import XiaoxinSnapshotData, _XiaoxinResponse

ENDPOINT = "/api/integrations/xiaoxin/knowledge-sync/notify"
TOKEN = "xiaoxin-test-token"
AUTH_HEADERS = {"Authorization": f"Bearer {TOKEN}"}
RAG_CONFIG = {
    "retriever_name": "test-retriever",
    "retriever_namespace": "default",
    "embedding_config": {
        "model_name": "test-embedding",
        "model_namespace": "default",
    },
}


def _notification(domains: list[str] | None = None) -> dict:
    return {
        "domains": domains or ["HR"],
        "sync_time": "2026-08-26 15:30:00",
        "operator": "zhangsan",
        "pull_api": "http://attacker.invalid/knowledge/pull",
    }


def _create_target(
    db: Session,
    owner_user_id: int,
    *,
    name: str = "xiaoxin-target",
    retrieval_config: dict | None = RAG_CONFIG,
) -> Kind:
    target = Kind(
        user_id=owner_user_id,
        kind="KnowledgeBase",
        namespace="xiaoxin-test",
        name=name,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {"name": name, "namespace": "xiaoxin-test"},
            "spec": {"name": name, "retrievalConfig": retrieval_config},
        },
        is_active=True,
    )
    db.add(target)
    db.commit()
    db.refresh(target)
    return target


def _configure_sync(
    monkeypatch: pytest.MonkeyPatch,
    user_id: int,
    *,
    target_id: int = 0,
    enabled: bool = True,
) -> None:
    monkeypatch.setattr(settings, "XIAOXIN_SYNC_ENABLED", enabled)
    monkeypatch.setattr(settings, "XIAOXIN_SYNC_TOKEN", TOKEN)
    monkeypatch.setattr(settings, "XIAOXIN_TARGET_KB_ID", target_id)
    monkeypatch.setattr(settings, "XIAOXIN_SYNC_USER_ID", user_id)


def _full_hr_snapshot() -> XiaoxinSnapshotData:
    return _XiaoxinResponse.model_validate(
        {
            "code": 0,
            "data": {
                "domain": "HR",
                "total": 4,
                "list": [
                    {
                        "knowledge_id": 1,
                        "question": "年假如何申请？",
                        "category": "假勤",
                        "updated_at": "2026-09-04 10:00:01",
                        "answer_scope": "public",
                        "answer": "通过系统提交申请。",
                    },
                    {
                        "knowledge_id": 2,
                        "question": "体检如何预约？",
                        "category": "商保体检",
                        "updated_at": "2026-09-04 10:00:02",
                        "answer_scope": "public",
                        "answer": "不应进入发布内容。",
                    },
                    {
                        "knowledge_id": 3,
                        "question": "地区福利是什么？",
                        "category": "福利",
                        "updated_at": "2026-09-04 10:00:03",
                        "answer_scope": "region",
                        "answers": [
                            {"region": "北京", "answer": "北京地区福利。"},
                            {"region": "深圳", "answer": "深圳地区福利。"},
                        ],
                    },
                    {
                        "knowledge_id": 4,
                        "question": "劳动合同政策是什么？",
                        "category": "ER政策法规",
                        "updated_at": "2026-09-04 10:00:04",
                        "answer_scope": "public",
                        "answer": "同样不应进入发布内容。",
                    },
                ],
            },
        }
    ).data


@contextmanager
def _task_session(db: Session) -> Iterator[Session]:
    yield db


def _run_external_import_task(
    monkeypatch: pytest.MonkeyPatch,
    db: Session,
    document: KnowledgeDocument,
) -> None:
    monkeypatch.setattr(
        knowledge_tasks_module,
        "SessionLocal",
        lambda: _task_session(db),
    )
    knowledge_tasks_module.import_external_document_task.run(
        document_id=document.id,
        expected_generation=document.index_generation,
    )


def _assert_imported_faq(
    db: Session,
    target: Kind,
    document: KnowledgeDocument,
    index_dispatch: MagicMock,
) -> None:
    db.refresh(document)
    attachment = db.get(SubtaskContext, document.attachment_id)
    assert attachment is not None
    assert db.query(KnowledgeDocument).filter_by(kind_id=target.id).count() == 1
    metadata = document.external_source_config
    assert {
        "provider": metadata["provider"],
        "resource_id": metadata["resource_id"],
        "domain": metadata["domain"],
        "source_total": metadata["source_total"],
        "filtered_count": metadata["filtered_count"],
        "generated_qa_count": metadata["generated_qa_count"],
    } == {
        "provider": "xiaoxin",
        "resource_id": "HR",
        "domain": "HR",
        "source_total": 4,
        "filtered_count": 2,
        "generated_qa_count": 3,
    }
    assert metadata["pull_elapsed_ms"] >= 0
    assert metadata["projection_elapsed_ms"] >= 0
    assert "商保体检" not in attachment.extracted_text
    assert "ER政策法规" not in attachment.extracted_text
    assert "不应进入发布内容" not in attachment.extracted_text
    assert "同样不应进入发布内容" not in attachment.extracted_text
    assert "更新时间：2026-09-04 10:00:01" in attachment.extracted_text
    assert attachment.extracted_text.count("更新时间：2026-09-04 10:00:03") == 2
    assert "北京地区福利" in attachment.extracted_text
    assert "深圳地区福利" in attachment.extracted_text
    index_dispatch.assert_called_once()


@pytest.fixture
def dispatched(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    document_ids: list[int] = []
    monkeypatch.setattr(
        knowledge_tasks_module,
        "import_external_document_task",
        SimpleNamespace(
            delay=lambda **kwargs: document_ids.append(kwargs["document_id"])
        ),
    )
    return document_ids


@pytest.mark.unit
def test_sync_configuration_defaults_are_closed_and_non_production() -> None:
    assert {
        field: Settings.model_fields[field].default
        for field in (
            "XIAOXIN_SYNC_ENABLED",
            "XIAOXIN_SYNC_TOKEN",
            "XIAOXIN_KNOWLEDGE_PULL_URL",
            "XIAOXIN_TARGET_KB_ID",
            "XIAOXIN_SYNC_USER_ID",
        )
    } == {
        "XIAOXIN_SYNC_ENABLED": False,
        "XIAOXIN_SYNC_TOKEN": "",
        "XIAOXIN_KNOWLEDGE_PULL_URL": "",
        "XIAOXIN_TARGET_KB_ID": 0,
        "XIAOXIN_SYNC_USER_ID": 0,
    }


@pytest.mark.integration
@pytest.mark.parametrize(
    ("configured_token", "headers"),
    [
        ("", AUTH_HEADERS),
        (TOKEN, {}),
        (TOKEN, {"Authorization": "Bearer wrong-token"}),
        (TOKEN, {"Authorization": "Basic credentials"}),
    ],
)
def test_token_failures_are_uniform_401(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    configured_token: str,
    headers: dict[str, str],
) -> None:
    monkeypatch.setattr(settings, "XIAOXIN_SYNC_TOKEN", configured_token)

    response = test_client.post(ENDPOINT, headers=headers, json=_notification())

    assert {
        "status_code": response.status_code,
        "detail": response.json()["detail"],
        "token_exposed": TOKEN in response.text,
    } == {
        "status_code": 401,
        "detail": "Unauthorized",
        "token_exposed": False,
    }


@pytest.mark.integration
def test_disabled_sync_rejects_hr_notification(
    test_client: TestClient,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_sync(monkeypatch, test_user.id, enabled=False)

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    assert response.status_code == 503


@pytest.mark.integration
def test_ignored_domains_return_202_without_resolving_target(
    test_client: TestClient,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_sync(monkeypatch, test_user.id, enabled=False)

    response = test_client.post(
        ENDPOINT,
        headers=AUTH_HEADERS,
        json=_notification(["IT", "FINANCE"]),
    )

    assert {
        "status_code": response.status_code,
        "body": response.json(),
    } == {
        "status_code": 202,
        "body": {
            "accepted_domains": [],
            "ignored_domains": ["IT", "FINANCE"],
            "status": "accepted",
        },
    }


@pytest.mark.integration
def test_hr_notification_creates_one_fixed_external_document(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    dispatched: list[int],
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)

    response = test_client.post(
        ENDPOINT,
        headers=AUTH_HEADERS,
        json=_notification(["HR", "IT", "HR"]),
    )

    document = test_db.query(KnowledgeDocument).one()
    source = test_db.query(KnowledgeDocumentExternalSource).one()
    assert {
        "status_code": response.status_code,
        "body": response.json(),
        "kind_id": document.kind_id,
        "name": document.name,
        "provider": source.external_provider,
        "resource_id": source.external_resource_id,
        "operator_persisted": "operator" in document.external_source_config,
        "sync_time_persisted": "sync_time" in document.external_source_config,
        "dispatched": dispatched,
    } == {
        "status_code": 202,
        "body": {
            "accepted_domains": ["HR"],
            "ignored_domains": ["IT"],
            "status": "accepted",
        },
        "kind_id": target.id,
        "name": "FAQ.md",
        "provider": "xiaoxin",
        "resource_id": "HR",
        "operator_persisted": False,
        "sync_time_persisted": False,
        "dispatched": [document.id],
    }


@pytest.mark.integration
def test_processing_notification_reuses_document_without_second_dispatch(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    dispatched: list[int],
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)

    first = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())
    second = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    document = test_db.query(KnowledgeDocument).one()
    assert {
        "status_codes": [first.status_code, second.status_code],
        "dispatched": dispatched,
    } == {
        "status_codes": [202, 202],
        "dispatched": [document.id],
    }


@pytest.mark.integration
def test_settled_notification_refreshes_same_document(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    dispatched: list[int],
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)
    test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())
    document = test_db.query(KnowledgeDocument).one()
    document.index_status = DocumentIndexStatus.SUCCESS
    document.is_active = True
    test_db.commit()

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    assert {
        "status_code": response.status_code,
        "document_id": test_db.query(KnowledgeDocument).one().id,
        "dispatched": dispatched,
    } == {
        "status_code": 202,
        "document_id": document.id,
        "dispatched": [document.id, document.id],
    }


@pytest.mark.integration
@pytest.mark.parametrize("target_state", ["missing", "inactive"])
def test_target_id_must_resolve_an_active_knowledge_base(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    target_state: str,
) -> None:
    target = _create_target(test_db, test_user.id)
    if target_state == "inactive":
        target.is_active = False
        test_db.commit()
        target_id = target.id
    else:
        target_id = target.id + 999
    _configure_sync(monkeypatch, test_user.id, target_id=target_id)

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    assert {
        "status_code": response.status_code,
        "document_count": test_db.query(KnowledgeDocument).count(),
    } == {
        "status_code": 503,
        "document_count": 0,
    }


@pytest.mark.integration
def test_target_is_resolved_by_configured_knowledge_base_id(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    dispatched: list[int],
) -> None:
    target = _create_target(test_db, test_user.id)
    _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    document = test_db.query(KnowledgeDocument).one()
    assert {
        "status_code": response.status_code,
        "target_id": document.kind_id,
        "dispatched": dispatched,
    } == {
        "status_code": 202,
        "target_id": target.id,
        "dispatched": [document.id],
    }


@pytest.mark.integration
def test_inactive_sync_user_is_rejected(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)
    test_user.is_active = False
    test_db.commit()

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    assert response.status_code == 503


@pytest.mark.integration
def test_target_without_rag_configuration_is_rejected(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _create_target(test_db, test_user.id, retrieval_config=None)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    assert response.status_code == 503


@pytest.mark.integration
def test_sync_user_without_manage_permission_is_rejected(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)
    sync_user = User(
        user_name="xiaoxin-sync-without-access",
        password_hash="not-used",
        email="xiaoxin-sync-without-access@example.com",
        is_active=True,
    )
    test_db.add(sync_user)
    test_db.commit()
    test_db.refresh(sync_user)
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=target.id,
            entity_type="user",
            entity_id=str(sync_user.id),
            entity_display_name=sync_user.user_name,
            user_id=sync_user.id,
            role=ResourceRole.Reporter.value,
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()
    monkeypatch.setattr(settings, "XIAOXIN_SYNC_USER_ID", sync_user.id)

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    assert response.status_code == 403


@pytest.mark.integration
def test_dispatch_failure_returns_non_2xx_and_keeps_single_retryable_document(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)

    def fail_dispatch(**kwargs) -> None:
        raise RuntimeError("broker unavailable")

    monkeypatch.setattr(
        knowledge_tasks_module,
        "import_external_document_task",
        SimpleNamespace(delay=fail_dispatch),
    )

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    document = test_db.query(KnowledgeDocument).one()
    assert {
        "status_code": response.status_code,
        "index_status": document.index_status,
        "error_code": document.processing_error_payload["code"],
        "token_exposed": TOKEN in response.text,
    } == {
        "status_code": 503,
        "index_status": DocumentIndexStatus.FAILED,
        "error_code": "external_import_dispatch_failed",
        "token_exposed": False,
    }


@pytest.mark.integration
def test_notification_runs_mocked_hr_snapshot_through_import_and_index_chain(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)
    dispatch = MagicMock()
    index_dispatch = MagicMock(return_value=SimpleNamespace(id="index-task"))
    monkeypatch.setattr(
        knowledge_tasks_module.import_external_document_task, "delay", dispatch
    )
    monkeypatch.setattr(
        knowledge_tasks_module.index_document_task, "delay", index_dispatch
    )

    monkeypatch.setattr(
        "app.services.knowledge.xiaoxin.pull_xiaoxin_hr_snapshot",
        AsyncMock(return_value=_full_hr_snapshot()),
    )

    response = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())

    document = test_db.query(KnowledgeDocument).one()
    import_generation = document.index_generation
    dispatch.assert_called_once_with(
        document_id=document.id,
        expected_generation=import_generation,
    )

    with caplog.at_level(
        logging.INFO,
        logger="app.services.knowledge.external_document_import",
    ):
        _run_external_import_task(monkeypatch, test_db, document)

    assert response.status_code == 202
    _assert_imported_faq(test_db, target, document, index_dispatch)
    record = next(
        item
        for item in caplog.records
        if item.message == "[External Import] Content fetched"
    )
    assert {
        "knowledge_base_id": record.knowledge_base_id,
        "document_id": record.document_id,
        "provider": record.provider,
        "index_generation": record.index_generation,
        "has_fetch_duration": record.fetch_elapsed_ms >= 0,
    } == {
        "knowledge_base_id": target.id,
        "document_id": document.id,
        "provider": "xiaoxin",
        "index_generation": import_generation + 1,
        "has_fetch_duration": True,
    }


@pytest.mark.integration
def test_repeated_daily_sync_refreshes_the_same_external_document(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    dispatched: list[int],
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)
    monkeypatch.setattr(
        settings,
        "XIAOXIN_KNOWLEDGE_PULL_URL",
        "http://xiaoxin.test/knowledge/pull",
    )
    monkeypatch.setattr(settings, "XIAOXIN_SIGN_SECRET", "placeholder-secret")
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.SessionLocal",
        lambda: nullcontext(test_db),
    )

    from app.tasks.xiaoxin_knowledge_tasks import sync_xiaoxin_hr_knowledge

    first = sync_xiaoxin_hr_knowledge.run()
    document = test_db.query(KnowledgeDocument).one()
    document.index_status = DocumentIndexStatus.SUCCESS
    document.is_active = True
    test_db.commit()
    second = sync_xiaoxin_hr_knowledge.run()

    assert test_db.query(KnowledgeDocument).count() == 1
    assert first["document_id"] == second["document_id"] == document.id
    assert dispatched == [document.id, document.id]


@pytest.mark.integration
def test_failed_refresh_is_retryable_by_the_next_notification(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    dispatched: list[int],
) -> None:
    target = _create_target(test_db, test_user.id)
    _configure_sync(monkeypatch, test_user.id, target_id=target.id)
    test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())
    document = test_db.query(KnowledgeDocument).one()
    document.index_status = DocumentIndexStatus.SUCCESS
    document.is_active = True
    test_db.commit()

    refreshing = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())
    test_db.refresh(document)
    failed_generation = document.index_generation

    provider = get_external_document_provider("xiaoxin")
    monkeypatch.setattr(
        provider,
        "fetch_content",
        AsyncMock(side_effect=ExternalDocumentFetchError("mock pull failure")),
    )
    run_external_document_import(
        test_db,
        document,
        test_user,
        generation=failed_generation,
    )
    test_db.refresh(document)
    failed_error = document.processing_error_payload

    retry = test_client.post(ENDPOINT, headers=AUTH_HEADERS, json=_notification())
    test_db.refresh(document)

    assert {
        "refresh_status": refreshing.status_code,
        "retry_status": retry.status_code,
        "failed_error_code": failed_error["code"],
        "failed_error_stage": failed_error["stage"],
        "document_status": document.index_status,
        "document_generation": document.index_generation,
        "document_error": document.processing_error_payload,
        "document_active": document.is_active,
        "document_count": test_db.query(KnowledgeDocument).count(),
        "dispatched": dispatched,
    } == {
        "refresh_status": 202,
        "retry_status": 202,
        "failed_error_code": "external_import_failed",
        "failed_error_stage": "system",
        "document_status": DocumentIndexStatus.QUEUED,
        "document_generation": failed_generation + 1,
        "document_error": None,
        "document_active": False,
        "document_count": 1,
        "dispatched": [document.id, document.id, document.id],
    }
