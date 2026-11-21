# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import httpx
import pytest
from qdrant_client.http.exceptions import ResponseHandlingException

from knowledge_runtime.services.admin_executor import AdminExecutor
from knowledge_runtime.services.config_resolver import AdminResolvedConfig
from shared.knowledge_cleanup import ExternalEngineCleanupError
from shared.models import RemoteDeleteDocumentIndexRequest, RuntimeRetrieverConfig


@pytest.mark.parametrize(
    "stage", ["published", "running", "failed", "deleted", "storage_changed"]
)
def test_version_cleanup_uses_durable_identity_and_rejects_live_versions(
    shared_model_db, stage
):
    from datetime import datetime, timedelta, timezone

    from knowledge_runtime.models.knowledge_document import KnowledgeDocument
    from knowledge_runtime.services.config_resolver import (
        ConfigResolutionError,
        ConfigResolver,
    )
    from knowledge_runtime.services.web_version_cleanup import resolve_retired_config
    from shared.knowledge_module.publication import publication_fingerprint
    from shared.models import RemoteAuthorizedIndexResources
    from shared.models.db import Kind
    from shared.models.db.subtask_context import SubtaskContext

    SubtaskContext.__table__.create(shared_model_db.get_bind(), checkfirst=True)
    retriever = (
        shared_model_db.query(Kind)
        .filter(Kind.kind == "Retriever", Kind.name == "test-retriever")
        .one()
    )
    authorized = RemoteAuthorizedIndexResources(
        operation="delete",
        knowledge_base_id=1,
        index_owner_user_id=42,
        retriever={
            "kind": "Retriever",
            "name": "test-retriever",
            "namespace": "default",
        },
    )
    attachment = SubtaskContext(
        user_id=42,
        context_type="attachment",
        name="web.md",
        type_data={
            "web_index_version": {
                "document_id": 11,
                "doc_ref": "11@2",
                "not_before": (
                    datetime.now(timezone.utc) - timedelta(days=1)
                ).isoformat(),
                "retriever_revision": {
                    "id": retriever.id,
                    "hash": publication_fingerprint(retriever.json),
                },
                "delete_spec": {
                    "knowledge_base_id": 1,
                    "index_owner_user_id": 42,
                    "authorized_resources": authorized.model_dump(mode="json"),
                },
            }
        },
    )
    shared_model_db.add(attachment)
    if stage != "deleted":
        shared_model_db.add(
            KnowledgeDocument(
                id=11,
                kind_id=1,
                index_generation=2,
                index_status="indexing" if stage == "running" else "failed",
                source_config={
                    "published_generation": 2 if stage == "published" else 1,
                    "_web_refresh": {"generation": 2, "doc_ref": "11@2"},
                },
            )
        )
    if stage == "storage_changed":
        retriever.json = {
            "spec": {
                "storageConfig": {"type": "qdrant", "url": "http://other-store:6333"}
            }
        }
    shared_model_db.commit()
    request = RemoteDeleteDocumentIndexRequest(
        knowledge_base_id=1,
        user_id=42,
        document_ref="11@2",
        authorized_resources=authorized,
        extensions={"version_attachment_id": attachment.id},
    )
    if stage in {"published", "running", "storage_changed"}:
        with pytest.raises(ConfigResolutionError):
            resolve_retired_config(shared_model_db, ConfigResolver(), request)
    else:
        config = resolve_retired_config(shared_model_db, ConfigResolver(), request)
        assert config.retriever_config.storage_config["url"] == "http://qdrant:6333"
        assert config.index_owner_user_id == 42


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["constructor", "delete"])
async def test_cleanup_external_failure_is_distinct_from_runtime_failure(
    stage: str,
) -> None:
    loader = MagicMock()
    loader.resolve_admin_config.return_value = AdminResolvedConfig(
        index_owner_user_id=1,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever",
            namespace="default",
            storage_config={"type": "qdrant", "url": "http://qdrant:6333"},
        ),
    )
    failure = ResponseHandlingException(httpx.ConnectError("private address"))
    storage = MagicMock()
    storage.delete_document.side_effect = failure
    with patch(
        "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
        side_effect=failure if stage == "constructor" else None,
        return_value=storage,
    ):
        with pytest.raises(ExternalEngineCleanupError) as caught:
            await AdminExecutor(config_loader=loader).delete_document_index(
                RemoteDeleteDocumentIndexRequest(
                    knowledge_base_id=1, user_id=1, document_ref="11"
                )
            )
    assert caught.value.reason == "connection_failed"
    assert "private address" not in str(caught.value)


@pytest.mark.asyncio
async def test_config_resolution_is_outside_the_external_failure_boundary() -> None:
    loader = MagicMock()
    error = ResponseHandlingException(httpx.ConnectError("internal source"))
    loader.resolve_admin_config.side_effect = error
    with pytest.raises(ResponseHandlingException) as caught:
        await AdminExecutor(config_loader=loader).delete_document_index(
            RemoteDeleteDocumentIndexRequest(
                knowledge_base_id=1, user_id=1, document_ref="11"
            )
        )
    assert caught.value is error


def test_external_cleanup_http_error_is_safe_and_machine_readable() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from knowledge_runtime.main import external_cleanup_error_handler

    app = FastAPI()
    app.add_exception_handler(
        ExternalEngineCleanupError, external_cleanup_error_handler
    )

    @app.post("/cleanup")
    def cleanup() -> None:
        raise ExternalEngineCleanupError("qdrant", "timeout")

    response = TestClient(app).post("/cleanup")
    assert response.status_code == 502
    assert response.json() == {
        "code": "external_engine_unavailable",
        "message": "External index cleanup could not be confirmed",
        "retryable": True,
        "details": {
            "stage": "external_index_cleanup",
            "storage_type": "qdrant",
            "reason": "timeout",
        },
    }


@pytest.mark.asyncio
async def test_runtime_deadline_is_not_an_external_engine_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    from knowledge_runtime.services import cleanup_deadline as deadline

    monkeypatch.setattr(deadline, "CLEANUP_TIMEOUT_SECONDS", 0.01)

    @deadline.cleanup_deadline
    async def blocked() -> None:
        await asyncio.Event().wait()

    with pytest.raises(asyncio.TimeoutError):
        await blocked()
