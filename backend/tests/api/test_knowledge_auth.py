# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Integration tests for knowledge API authentication via JWT Bearer and task tokens."""

from fastapi.testclient import TestClient


class TestKnowledgeApiJwtAuth:
    """Tests for knowledge API endpoints using JWT Bearer token authentication."""

    def test_list_with_jwt_bearer_returns_200(
        self, test_client: TestClient, test_token: str
    ):
        """GET /api/knowledge/list with JWT Bearer token should authenticate successfully."""
        response = test_client.get(
            "/api/knowledge/list",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        body = response.json()
        assert "items" in body
        assert "total" in body

    def test_list_with_scope_personal_returns_200(
        self, test_client: TestClient, test_token: str
    ):
        """GET /api/knowledge/list?scope=personal with JWT Bearer token should work."""
        response = test_client.get(
            "/api/knowledge/list",
            params={"scope": "personal"},
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        body = response.json()
        assert "items" in body

    def test_list_no_auth_returns_401(self, test_client: TestClient):
        """GET /api/knowledge/list without any auth should return 401."""
        response = test_client.get("/api/knowledge/list")

        assert response.status_code == 401
        body = response.json()
        assert "API key is required" in body.get("detail", "")

    def test_search_with_jwt_bearer_auth_passes(
        self, test_client: TestClient, test_token: str
    ):
        """POST /api/knowledge/search with JWT Bearer token should pass auth (422 on missing kb_id is OK)."""
        response = test_client.post(
            "/api/knowledge/search",
            json={"query": "test", "limit": 3},
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code != 401

    def test_list_with_task_token_returns_200(
        self, test_client: TestClient, test_task_token: str
    ):
        """GET /api/knowledge/list with task token should pass auth and return data."""
        response = test_client.get(
            "/api/knowledge/list",
            headers={"Authorization": f"Bearer {test_task_token}"},
        )

        assert response.status_code == 200
        body = response.json()
        assert "items" in body
        assert "total" in body
