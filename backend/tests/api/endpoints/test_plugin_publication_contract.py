# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP contract tests for user and administrator publication views."""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.schemas.plugin_publication import (
    PluginPublicationActionEligibility,
    PluginPublicationCreateRequest,
    PluginPublicationRequestDetail,
    PluginPublicationRequestListResponse,
    PluginPublicationRevisionItem,
    PluginPublicationSubmitter,
    PluginPublicationUploadResponse,
)
from app.services.plugin_publication_service import plugin_publication_service


def _detail() -> PluginPublicationRequestDetail:
    now = datetime(2026, 8, 29, 12, 0, 0)
    revision = PluginPublicationRevisionItem(
        id=101,
        number=1,
        requestedVersion="1.0.0",
        snapshotSha256="a" * 64,
        sourceTreeSha256="b" * 64,
        status="awaiting_admin",
        createdAt=now,
        manifest={"name": "publication-contract"},
        packageEntries=[".codex-plugin/plugin.json"],
        packageEntryCount=1,
        capabilities=["skill:review"],
    )
    return PluginPublicationRequestDetail(
        id=11,
        pluginId=21,
        pluginName="Publication Contract",
        pluginSlug="publication-contract",
        requestedVersion="1.0.0",
        submitter=PluginPublicationSubmitter(
            id=7,
            userName="submitter",
            email="submitter@example.com",
        ),
        currentRevision=2,
        stage="administrator_review",
        status="awaiting_admin",
        riskLevel="low",
        blockerCount=0,
        warningCount=1,
        gitlabStatus="running",
        waitingDurationSeconds=90,
        submittedAt=now,
        updatedAt=now,
        revision=revision,
        revisions=[revision],
        actionEligibility=PluginPublicationActionEligibility(canWithdraw=True),
    )


def _upload() -> PluginPublicationUploadResponse:
    now = datetime(2026, 8, 29, 12, 0, 0)
    return PluginPublicationUploadResponse(
        requestId=11,
        sourcePluginId=21,
        revision=PluginPublicationRevisionItem(
            id=101,
            number=1,
            requestedVersion="1.0.0",
            snapshotSha256="a" * 64,
            status="uploading",
            releaseNotes="Initial enterprise release",
            testNotes="Validated on Windows and macOS",
            createdAt=now,
        ),
        uploadUrl="https://storage.example.com/upload",
        expiresAt=now,
    )


def _create_payload() -> dict[str, object]:
    return {
        "slug": "publication-contract",
        "displayName": "Publication Contract",
        "requestedVersion": "1.0.0",
        "filename": "plugin.zip",
        "snapshotSha256": "a" * 64,
        "sizeBytes": 128,
        "releaseNotes": "Initial enterprise release",
        "testNotes": "Validated on Windows and macOS",
    }


def test_publication_routes_forward_revision_and_submission_time_queries(
    test_client: TestClient,
    test_token: str,
    test_admin_token: str,
    monkeypatch,
) -> None:
    list_calls: list[dict] = []
    detail_calls: list[dict] = []

    def list_requests(db, **kwargs):
        del db
        list_calls.append(kwargs)
        return PluginPublicationRequestListResponse(
            items=[], total=0, page=kwargs["page"], limit=kwargs["limit"]
        )

    def get_request(db, **kwargs):
        del db
        detail_calls.append(kwargs)
        return _detail()

    monkeypatch.setattr(plugin_publication_service, "list_requests", list_requests)
    monkeypatch.setattr(plugin_publication_service, "get_request", get_request)

    user_headers = {"Authorization": f"Bearer {test_token}"}
    user_list = test_client.get(
        "/api/plugins/publication-requests",
        params={
            "submittedAfter": "2026-08-01T00:00:00Z",
            "submittedBefore": "2026-08-31T23:59:59Z",
        },
        headers=user_headers,
    )
    assert user_list.status_code == 200
    assert list_calls[-1]["submitted_after"].isoformat() == (
        "2026-08-01T00:00:00+00:00"
    )
    assert list_calls[-1]["submitted_before"].isoformat() == (
        "2026-08-31T23:59:59+00:00"
    )
    user_detail = test_client.get(
        "/api/plugins/publication-requests/11",
        params={"revision": 1},
        headers=user_headers,
    )
    assert user_detail.status_code == 200
    assert detail_calls[-1]["revision_number"] == 1
    assert user_detail.json()["revision"]["number"] == 1
    assert user_detail.json()["currentRevision"] == 2

    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}
    admin_list = test_client.get(
        "/api/admin/plugins/publication-requests",
        params={
            "submittedAfter": "2026-08-01T00:00:00Z",
            "submittedBefore": "2026-08-31T23:59:59Z",
        },
        headers=admin_headers,
    )
    assert admin_list.status_code == 200
    assert list_calls[-1]["is_admin"] is True
    admin_detail = test_client.get(
        "/api/admin/plugins/publication-requests/11",
        params={"revision": 1},
        headers=admin_headers,
    )
    assert admin_detail.status_code == 200
    assert detail_calls[-1]["is_admin"] is True
    assert detail_calls[-1]["revision_number"] == 1
    assert admin_detail.json()["revision"]["manifest"] == {
        "name": "publication-contract"
    }


@pytest.mark.parametrize(
    ("path", "payload", "is_admin"),
    (
        ("/api/plugins/publication-requests", _create_payload(), False),
        (
            "/api/plugins/publication-requests/11/revisions",
            {
                "requestedVersion": "1.0.1",
                "filename": "plugin.zip",
                "snapshotSha256": "b" * 64,
                "sizeBytes": 128,
                "releaseNotes": "Fix review feedback",
                "testNotes": "Retested on Windows and macOS",
            },
            False,
        ),
        ("/api/plugins/publication-requests/11/revisions/1/complete", None, False),
        ("/api/plugins/publication-requests/11/withdraw", None, False),
        (
            "/api/admin/plugins/publication-requests/11/return",
            {
                "currentRevision": 1,
                "reason": "Please fix the declared issue",
                "requiredChanges": ["Remove the unsafe command"],
            },
            True,
        ),
        (
            "/api/admin/plugins/publication-requests/11/accept",
            {"currentRevision": 1, "acknowledgedWarningCodes": []},
            True,
        ),
        (
            "/api/admin/plugins/publication-requests/11/reconcile",
            {"currentRevision": 1},
            True,
        ),
    ),
)
def test_publication_mutations_require_idempotency_key(
    test_client: TestClient,
    test_token: str,
    test_admin_token: str,
    path: str,
    payload: dict[str, object] | None,
    is_admin: bool,
) -> None:
    token = test_admin_token if is_admin else test_token
    response = test_client.post(
        path,
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
    )

    assert response.status_code == 422
    assert any(
        error["loc"] == ["header", "Idempotency-Key"]
        for error in response.json()["errors"]
    )


def test_create_publication_request_replays_same_key_and_rejects_changed_payload(
    test_client: TestClient,
    test_token: str,
    monkeypatch,
) -> None:
    calls = 0

    def create_request(db, **kwargs):
        nonlocal calls
        del db, kwargs
        calls += 1
        return _upload()

    monkeypatch.setattr(plugin_publication_service, "create_request", create_request)
    headers = {
        "Authorization": f"Bearer {test_token}",
        "Idempotency-Key": "publication-create-001",
    }

    first = test_client.post(
        "/api/plugins/publication-requests",
        headers=headers,
        json=_create_payload(),
    )
    replay = test_client.post(
        "/api/plugins/publication-requests",
        headers=headers,
        json=_create_payload(),
    )
    changed_payload = {**_create_payload(), "releaseNotes": "Changed release notes"}
    conflict = test_client.post(
        "/api/plugins/publication-requests",
        headers=headers,
        json=changed_payload,
    )

    assert first.status_code == 201
    assert replay.status_code == 201
    assert first.json() == replay.json()
    assert conflict.status_code == 409
    assert calls == 1


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("releaseNotes", "   "),
        ("testNotes", "   "),
        ("releaseNotes", "x" * 2001),
        ("testNotes", "x" * 1001),
    ),
)
def test_publication_snapshot_requires_client_bounded_notes(
    field: str, value: str
) -> None:
    payload = _create_payload()
    payload[field] = value

    with pytest.raises(ValidationError):
        PluginPublicationCreateRequest.model_validate(payload)
