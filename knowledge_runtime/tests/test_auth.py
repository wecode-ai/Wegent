# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for authentication middleware."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from knowledge_runtime.config import get_settings, reset_settings
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

    app = FastAPI()

    @app.get("/protected")
    async def protected_endpoint():
        return {"status": "ok"}

    @app.get("/health")
    async def health_endpoint():
        return {"status": "healthy"}

    return app


def test_auth_disabled_when_token_empty(test_app, monkeypatch):
    """Test that authentication is skipped when token is not configured."""
    # Set empty token
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")

    # Reset settings to pick up the new env
    reset_settings()

    # Add auth dependency to protected endpoint
    from fastapi import Depends

    test_app.routes.clear()

    @test_app.get("/protected", dependencies=[Depends(verify_internal_token)])
    async def protected_endpoint():
        return {"status": "ok"}

    client = TestClient(test_app)

    # Should work without any auth header
    response = client.get("/protected")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_protected_endpoint_missing_token(test_app, monkeypatch):
    """Test that missing token returns 401."""
    # Set a token
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "test-token-123")
    reset_settings()

    # Add auth dependency to protected endpoint
    from fastapi import Depends

    test_app.routes.clear()

    @test_app.get("/protected", dependencies=[Depends(verify_internal_token)])
    async def protected_endpoint():
        return {"status": "ok"}

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

    from fastapi import Depends

    test_app.routes.clear()

    @test_app.get("/protected", dependencies=[Depends(verify_internal_token)])
    async def protected_endpoint():
        return {"status": "ok"}

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

    from fastapi import Depends

    test_app.routes.clear()

    @test_app.get("/protected", dependencies=[Depends(verify_internal_token)])
    async def protected_endpoint():
        return {"status": "ok"}

    client = TestClient(test_app)

    # Request with correct token should succeed
    response = client.get(
        "/protected",
        headers={"Authorization": "Bearer correct-token"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_endpoint_no_auth_required(test_app, monkeypatch):
    """Test that health endpoint works without authentication."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "test-token")
    reset_settings()

    # Health endpoint should not have auth dependency
    client = TestClient(test_app)

    # Health endpoint should work without auth
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_token_with_special_characters(test_app, monkeypatch):
    """Test that tokens with special characters work correctly."""
    special_token = "token-with-special-chars_123!@#$%"
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", special_token)
    reset_settings()

    from fastapi import Depends

    test_app.routes.clear()

    @test_app.get("/protected", dependencies=[Depends(verify_internal_token)])
    async def protected_endpoint():
        return {"status": "ok"}

    client = TestClient(test_app)

    # Request with matching special token should succeed
    response = client.get(
        "/protected",
        headers={"Authorization": f"Bearer {special_token}"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_bearer_scheme_case_insensitive(test_app, monkeypatch):
    """Test that Bearer scheme is case-insensitive per RFC 6750."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "test-token")
    reset_settings()

    from fastapi import Depends

    test_app.routes.clear()

    @test_app.get("/protected", dependencies=[Depends(verify_internal_token)])
    async def protected_endpoint():
        return {"status": "ok"}

    client = TestClient(test_app)

    # "bearer" (lowercase) should also work
    response = client.get(
        "/protected",
        headers={"Authorization": "bearer test-token"},
    )
    # FastAPI's HTTPBearer handles case-insensitive scheme by default
    assert response.status_code == 200
