# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.plugin_publication import PluginPublicationIdempotency
from app.services.plugin_publication_idempotency import (
    PluginPublicationIdempotencyService,
)


class _Response(BaseModel):
    value: str


def test_publication_idempotency_replays_same_request_and_rejects_conflict(
    test_db: Session,
) -> None:
    service = PluginPublicationIdempotencyService()
    calls = 0

    def action() -> _Response:
        nonlocal calls
        calls += 1
        test_db.commit()
        return _Response(value="created")

    first = service.execute(
        test_db,
        principal_type="user",
        principal_id=7,
        operation="publication_request.create",
        idempotency_key="request-key-001",
        resource_key="source:example",
        payload={"version": "1.0.0", "sha256": "a" * 64},
        response_model=_Response,
        action=action,
    )
    replay = service.execute(
        test_db,
        principal_type="user",
        principal_id=7,
        operation="publication_request.create",
        idempotency_key="request-key-001",
        resource_key="source:example",
        payload={"version": "1.0.0", "sha256": "a" * 64},
        response_model=_Response,
        action=action,
    )

    assert first == replay == _Response(value="created")
    assert calls == 1

    with pytest.raises(HTTPException) as exc_info:
        service.execute(
            test_db,
            principal_type="user",
            principal_id=7,
            operation="publication_request.create",
            idempotency_key="request-key-001",
            resource_key="source:example",
            payload={"version": "1.0.1", "sha256": "b" * 64},
            response_model=_Response,
            action=action,
        )
    assert exc_info.value.status_code == 409


def test_publication_idempotency_scopes_keys_to_principal_and_operation(
    test_db: Session,
) -> None:
    service = PluginPublicationIdempotencyService()

    def execute(principal_id: int, operation: str, value: str) -> _Response:
        return service.execute(
            test_db,
            principal_type="user",
            principal_id=principal_id,
            operation=operation,
            idempotency_key="shared-key-001",
            resource_key="request:1",
            payload={"value": value},
            response_model=_Response,
            action=lambda: _Response(value=value),
        )

    assert execute(1, "publication_request.withdraw", "first").value == "first"
    assert execute(2, "publication_request.withdraw", "second").value == "second"
    assert execute(1, "publication_request.reconcile", "third").value == "third"

    assert test_db.query(PluginPublicationIdempotency).count() == 3


def test_publication_idempotency_allows_retry_after_failure_and_preserves_binding(
    test_db: Session,
) -> None:
    service = PluginPublicationIdempotencyService()

    def failed_action() -> _Response:
        raise RuntimeError("external dependency failed")

    with pytest.raises(RuntimeError, match="external dependency failed"):
        service.execute(
            test_db,
            principal_type="admin",
            principal_id=9,
            operation="publication_request.accept",
            idempotency_key="accept-key-001",
            resource_key="request:4:revision:2",
            payload={"currentRevision": 2},
            response_model=_Response,
            action=failed_action,
        )

    binding = test_db.query(PluginPublicationIdempotency).one()
    assert binding.status == "failed"

    with pytest.raises(HTTPException) as exc_info:
        service.execute(
            test_db,
            principal_type="admin",
            principal_id=9,
            operation="publication_request.accept",
            idempotency_key="accept-key-001",
            resource_key="request:4:revision:2",
            payload={"currentRevision": 3},
            response_model=_Response,
            action=lambda: _Response(value="must-not-run"),
        )
    assert exc_info.value.status_code == 409

    result = service.execute(
        test_db,
        principal_type="admin",
        principal_id=9,
        operation="publication_request.accept",
        idempotency_key="accept-key-001",
        resource_key="request:4:revision:2",
        payload={"currentRevision": 2},
        response_model=_Response,
        action=lambda: _Response(value="retried"),
    )

    assert result.value == "retried"
    test_db.refresh(binding)
    assert binding.status == "completed"
