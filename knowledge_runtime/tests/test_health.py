# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient

from knowledge_runtime.main import create_app


def test_health_endpoint() -> None:
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_internal_route_rejects_missing_auth() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/internal/rag/query",
        json={"knowledge_base_ids": [1], "query": "release checklist"},
    )

    assert response.status_code == 401
