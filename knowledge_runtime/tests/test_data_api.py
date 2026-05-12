# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for data analysis API endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from knowledge_runtime.api.endpoints.data import router
from knowledge_runtime.config import reset_settings
from shared.models.data_analysis_protocol import (
    RemoteDataGenerateResponse,
    RemoteDataQueryResponse,
    RemoteDataSchemaResponse,
)


@pytest.fixture(autouse=True)
def reset_settings_fixture():
    """Reset settings before and after each test."""
    reset_settings()
    yield
    reset_settings()


@pytest.fixture
def test_app():
    """Create a test FastAPI app with data endpoints mounted."""
    app = FastAPI()

    # Mount the data router at the expected prefix
    from knowledge_runtime.middleware.auth import verify_internal_token

    app.include_router(
        router,
        prefix="/internal/data",
    )

    return app


@pytest.fixture
def client(test_app):
    """Create a test client for the data API."""
    return TestClient(test_app)


def _make_generate_request() -> dict:
    """Create a valid generate request payload."""
    return {
        "attachment_id": 42,
        "content_ref": {
            "kind": "backend_attachment_stream",
            "url": "http://backend:8000/api/internal/rag/content/42",
            "auth_token": "test-token",
        },
        "source_file": "test_data",
        "file_extension": ".csv",
    }


def _make_query_request() -> dict:
    """Create a valid query request payload."""
    return {
        "attachment_id": 42,
        "content_ref": {
            "kind": "backend_attachment_stream",
            "url": "http://backend:8000/api/internal/rag/content/42",
            "auth_token": "test-token",
        },
        "sql": "SELECT * FROM data_db.sales LIMIT 10",
    }


def _make_schema_request() -> dict:
    """Create a valid schema request payload."""
    return {
        "attachment_id": 42,
        "content_ref": {
            "kind": "backend_attachment_stream",
            "url": "http://backend:8000/api/internal/rag/content/42",
            "auth_token": "test-token",
        },
    }


class TestGenerateEndpoint:
    """Tests for POST /internal/data/generate."""

    @patch(
        "knowledge_runtime.api.endpoints.data._data_service",
    )
    def test_generate_endpoint_exists(self, mock_service, client, monkeypatch) -> None:
        """POST /internal/data/generate endpoint should exist and be reachable."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
        reset_settings()

        mock_service.generate_duckdb = AsyncMock(
            return_value=RemoteDataGenerateResponse(
                success=True,
                attachment_id=42,
                duckdb_attachment_id=99,
                tables=[],
            )
        )

        response = client.post("/internal/data/generate", json=_make_generate_request())
        # Should not be 404 or 405
        assert response.status_code != 404
        assert response.status_code != 405

    @patch(
        "knowledge_runtime.api.endpoints.data._data_service",
    )
    def test_generate_endpoint_returns_response(
        self, mock_service, client, monkeypatch
    ) -> None:
        """POST /internal/data/generate should return generation response."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
        reset_settings()

        mock_service.generate_duckdb = AsyncMock(
            return_value=RemoteDataGenerateResponse(
                success=True,
                attachment_id=42,
                duckdb_attachment_id=99,
                tables=[],
                generation_time_ms=150.0,
            )
        )

        response = client.post("/internal/data/generate", json=_make_generate_request())
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["attachment_id"] == 42
        assert data["duckdb_attachment_id"] == 99


class TestQueryEndpoint:
    """Tests for POST /internal/data/query."""

    @patch(
        "knowledge_runtime.api.endpoints.data._data_service",
    )
    def test_query_endpoint_exists(self, mock_service, client, monkeypatch) -> None:
        """POST /internal/data/query endpoint should exist and be reachable."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
        reset_settings()

        mock_service.query_duckdb = AsyncMock(
            return_value=RemoteDataQueryResponse(
                success=True,
                columns=["id", "name"],
                rows=[[1, "Alice"]],
                row_count=1,
            )
        )

        response = client.post("/internal/data/query", json=_make_query_request())
        assert response.status_code != 404
        assert response.status_code != 405

    @patch(
        "knowledge_runtime.api.endpoints.data._data_service",
    )
    def test_query_endpoint_returns_response(
        self, mock_service, client, monkeypatch
    ) -> None:
        """POST /internal/data/query should return query response."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
        reset_settings()

        mock_service.query_duckdb = AsyncMock(
            return_value=RemoteDataQueryResponse(
                success=True,
                columns=["id", "name"],
                rows=[[1, "Alice"], [2, "Bob"]],
                row_count=2,
                truncated=False,
            )
        )

        response = client.post("/internal/data/query", json=_make_query_request())
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["columns"] == ["id", "name"]
        assert data["row_count"] == 2


class TestSchemaEndpoint:
    """Tests for POST /internal/data/schema."""

    @patch(
        "knowledge_runtime.api.endpoints.data._data_service",
    )
    def test_schema_endpoint_exists(self, mock_service, client, monkeypatch) -> None:
        """POST /internal/data/schema endpoint should exist and be reachable."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
        reset_settings()

        mock_service.get_schema = AsyncMock(
            return_value=RemoteDataSchemaResponse(
                attachment_id=42,
                tables=[],
            )
        )

        response = client.post("/internal/data/schema", json=_make_schema_request())
        assert response.status_code != 404
        assert response.status_code != 405

    @patch(
        "knowledge_runtime.api.endpoints.data._data_service",
    )
    def test_schema_endpoint_returns_response(
        self, mock_service, client, monkeypatch
    ) -> None:
        """POST /internal/data/schema should return schema response."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
        reset_settings()

        mock_service.get_schema = AsyncMock(
            return_value=RemoteDataSchemaResponse(
                attachment_id=42,
                tables=[
                    {
                        "name": "sales",
                        "row_count": 100,
                        "columns": [
                            {"name": "id", "type": "INTEGER", "null_count": 0},
                        ],
                    }
                ],
            )
        )

        response = client.post("/internal/data/schema", json=_make_schema_request())
        assert response.status_code == 200
        data = response.json()
        assert data["attachment_id"] == 42
        assert len(data["tables"]) == 1


class TestAuthRequirement:
    """Tests for authentication requirement on data endpoints."""

    def test_generate_endpoint_requires_auth_when_token_set(
        self, client, monkeypatch
    ) -> None:
        """POST /internal/data/generate should require auth when token is set."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret-token")
        reset_settings()

        # Create a fresh app with auth dependency
        from fastapi import Depends

        from knowledge_runtime.middleware.auth import verify_internal_token

        app = FastAPI()
        app.include_router(
            router,
            prefix="/internal/data",
            dependencies=[Depends(verify_internal_token)],
        )
        auth_client = TestClient(app)

        response = auth_client.post(
            "/internal/data/generate", json=_make_generate_request()
        )
        assert response.status_code == 401

    def test_query_endpoint_requires_auth_when_token_set(
        self, client, monkeypatch
    ) -> None:
        """POST /internal/data/query should require auth when token is set."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret-token")
        reset_settings()

        from fastapi import Depends

        from knowledge_runtime.middleware.auth import verify_internal_token

        app = FastAPI()
        app.include_router(
            router,
            prefix="/internal/data",
            dependencies=[Depends(verify_internal_token)],
        )
        auth_client = TestClient(app)

        response = auth_client.post("/internal/data/query", json=_make_query_request())
        assert response.status_code == 401

    def test_schema_endpoint_requires_auth_when_token_set(
        self, client, monkeypatch
    ) -> None:
        """POST /internal/data/schema should require auth when token is set."""
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret-token")
        reset_settings()

        from fastapi import Depends

        from knowledge_runtime.middleware.auth import verify_internal_token

        app = FastAPI()
        app.include_router(
            router,
            prefix="/internal/data",
            dependencies=[Depends(verify_internal_token)],
        )
        auth_client = TestClient(app)

        response = auth_client.post(
            "/internal/data/schema", json=_make_schema_request()
        )
        assert response.status_code == 401
