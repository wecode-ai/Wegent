# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""API coverage for the external event provider catalog."""

from fastapi.testclient import TestClient


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_external_event_catalog_requires_auth(test_client: TestClient) -> None:
    response = test_client.get("/api/v1/external-events/catalog")
    assert response.status_code == 401


def test_external_event_catalog_lists_adapter_event_types(
    test_client: TestClient,
    test_token: str,
) -> None:
    response = test_client.get(
        "/api/v1/external-events/catalog",
        headers=_auth(test_token),
    )
    assert response.status_code == 200
    gitlab = [event for event in response.json() if event["provider"] == "gitlab"]
    assert {event["event_type"] for event in gitlab} == {
        "merged",
        "ci_failed",
        "review_comment",
    }
    for event in gitlab:
        assert event["category"]
        assert event["description"]
