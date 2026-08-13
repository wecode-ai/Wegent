# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for the inbound GitLab MR webhook endpoint."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.gitlab_mr import MRIntegration


def _make_integration(
    db: Session,
    *,
    token: str = "tok1",
    zid: str = "secret",
    repo: str = "group/project",
) -> MRIntegration:
    integration = MRIntegration(
        cloud_project_id="1",
        project_key="PRJ",
        repository=repo,
        domain="gitlab.internal",
        api_base="https://gitlab.internal/api/v4",
        webhook_token=token,
        webhook_secret=zid,
        enabled=True,
        status="ok",
    )
    db.add(integration)
    db.commit()
    return integration


def _base_payload(repo: str = "group/project") -> dict[str, object]:
    return {"object_kind": "merge_request", "project": {"path_with_namespace": repo}}


def test_unknown_webhook_token_404(test_client: TestClient, test_db: Session) -> None:
    response = test_client.post("/api/v1/webhooks/gitlab/mr/does-not-exist")
    assert response.status_code == 404


def test_missing_gitlab_token_header_401(
    test_client: TestClient, test_db: Session
) -> None:
    _make_integration(test_db)
    response = test_client.post("/api/v1/webhooks/gitlab/mr/tok1", json=_base_payload())
    assert response.status_code == 401


def test_wrong_gitlab_token_401(test_client: TestClient, test_db: Session) -> None:
    _make_integration(test_db)
    response = test_client.post(
        "/api/v1/webhooks/gitlab/mr/tok1",
        headers={"X-Gitlab-Token": "wrong"},
        json=_base_payload(),
    )
    assert response.status_code == 401


def test_repo_mismatch_403(test_client: TestClient, test_db: Session) -> None:
    _make_integration(test_db, repo="group/project")
    response = test_client.post(
        "/api/v1/webhooks/gitlab/mr/tok1",
        headers={"X-Gitlab-Token": "secret"},
        json=_base_payload(repo="other/repo"),
    )
    assert response.status_code == 403


def test_unsupported_event_kind_returns_200_ignored(
    test_client: TestClient,
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _make_integration(test_db)
    dispatched: list[object] = []
    from app.tasks import gitlab_mr_tasks

    monkeypatch.setattr(
        gitlab_mr_tasks.process_gitlab_event,
        "apply_async",
        lambda *args, **kwargs: dispatched.append(args),
    )
    response = test_client.post(
        "/api/v1/webhooks/gitlab/mr/tok1",
        headers={"X-Gitlab-Token": "secret"},
        json={
            "object_kind": "push",
            "project": {"path_with_namespace": "group/project"},
        },
    )
    assert response.status_code == 200
    assert response.json()["ignored"] is True
    assert dispatched == []


def test_non_mr_note_ignored(
    test_client: TestClient,
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _make_integration(test_db)
    dispatched: list[object] = []
    from app.tasks import gitlab_mr_tasks

    monkeypatch.setattr(
        gitlab_mr_tasks.process_gitlab_event,
        "apply_async",
        lambda *args, **kwargs: dispatched.append(args),
    )
    response = test_client.post(
        "/api/v1/webhooks/gitlab/mr/tok1",
        headers={"X-Gitlab-Token": "secret"},
        json={
            "object_kind": "note",
            "project": {"path_with_namespace": "group/project"},
            "object_attributes": {"noteable_type": "Issue"},
        },
    )
    assert response.status_code == 200
    assert response.json()["ignored"] is True
    assert dispatched == []


def test_valid_event_dispatches_to_worker(
    test_client: TestClient,
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _make_integration(test_db)
    dispatched: list[tuple[object, ...]] = []
    from app.tasks import gitlab_mr_tasks

    monkeypatch.setattr(
        gitlab_mr_tasks.process_gitlab_event,
        "apply_async",
        lambda *args, **kwargs: dispatched.append(kwargs.get("args") or args),
    )
    payload = {
        "object_kind": "merge_request",
        "project": {"path_with_namespace": "group/project"},
        "object_attributes": {"iid": 1, "state": "opened"},
    }
    response = test_client.post(
        "/api/v1/webhooks/gitlab/mr/tok1",
        headers={"X-Gitlab-Token": "secret"},
        json=payload,
    )
    assert response.status_code == 200
    assert len(dispatched) == 1
    integration_id, event_kind, dispatched_payload = dispatched[0]
    assert event_kind == "merge_request"
    assert dispatched_payload == payload


def test_disabled_integration_404(test_client: TestClient, test_db: Session) -> None:
    integration = _make_integration(test_db)
    integration.enabled = False
    test_db.commit()
    response = test_client.post(
        "/api/v1/webhooks/gitlab/mr/tok1",
        headers={"X-Gitlab-Token": "secret"},
        json=_base_payload(),
    )
    assert response.status_code == 404
