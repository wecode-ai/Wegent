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
