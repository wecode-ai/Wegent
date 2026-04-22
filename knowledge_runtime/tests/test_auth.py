# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for authentication middleware."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from knowledge_runtime.config import reset_settings
from knowledge_runtime.middleware.auth import verify_internal_token


@pytest.fixture(autouse=True)
def reset_settings_fixture():
    """Reset settings before and after each test."""
    reset_settings()
    yield
    reset_settings()


@pytest.fixture
def test_app():
    """Create a test FastAPI app with auth dependency."""
    from fastapi import Depends

    app = FastAPI()

    @app.get("/protected", dependencies=[Depends(verify_internal_token)])
    async def protected_endpoint():
        return {"status": "ok"}

    return app


def test_auth_disabled_when_token_empty(test_app, monkeypatch):
    """Test that authentication is skipped when token is not configured."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
    reset_settings()

    client = TestClient(test_app)

    # Should work without any auth header
    response = client.get("/protected")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_protected_endpoint_missing_token(test_app, monkeypatch):
    """Test that missing token returns 401."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "test-token-123")
    reset_settings()

    client = TestClient(test_app)

    # Request without auth header should fail
    response = client.get("/protected")
    assert response.status_code == 401
    assert response.json() == {"detail": "Missing authentication token"}
    assert response.headers.get("WWW-Authenticate") == "Bearer"


def test_protected_endpoint_invalid_token(test_app, monkeypatch):
    """Test that invalid token returns 401."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "correct-token")
    reset_settings()

    client = TestClient(test_app)

    # Request with wrong token should fail
    response = client.get(
        "/protected",
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication token"}
    assert response.headers.get("WWW-Authenticate") == "Bearer"


def test_protected_endpoint_valid_token(test_app, monkeypatch):
    """Test that valid token allows access."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "correct-token")
    reset_settings()

    client = TestClient(test_app)

    # Request with correct token should succeed
    response = client.get(
        "/protected",
        headers={"Authorization": "Bearer correct-token"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
