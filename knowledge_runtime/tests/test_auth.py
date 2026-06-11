# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for authentication middleware."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from knowledge_runtime.config import reset_settings
from knowledge_runtime.middleware.auth import (
    require_internal_service_token_configured,
    verify_internal_token,
)


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


def test_protected_endpoint_rejects_when_token_empty(test_app, monkeypatch):
    """Test that authentication fails closed when token is not configured."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
    reset_settings()

    client = TestClient(test_app)

    response = client.get("/protected")
    assert response.status_code == 401
    assert response.json() == {"detail": "Internal service token is not configured"}
    assert response.headers.get("WWW-Authenticate") == "Bearer"


def test_protected_endpoint_rejects_when_token_whitespace(test_app, monkeypatch):
    """Test that whitespace-only tokens are treated as unconfigured."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "   ")
    reset_settings()

    client = TestClient(test_app)

    response = client.get(
        "/protected",
        headers={"Authorization": "Bearer any-token"},
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Internal service token is not configured"}
    assert response.headers.get("WWW-Authenticate") == "Bearer"


def test_startup_config_check_rejects_unconfigured_token(monkeypatch):
    """Test that startup fails when protected internal endpoints cannot authenticate."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "")
    reset_settings()

    with pytest.raises(RuntimeError) as exc_info:
        require_internal_service_token_configured()

    assert "INTERNAL_SERVICE_TOKEN is required" in str(exc_info.value)


def test_startup_config_check_rejects_whitespace_token(monkeypatch):
    """Test that startup rejects whitespace-only internal service tokens."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "   ")
    reset_settings()

    with pytest.raises(RuntimeError) as exc_info:
        require_internal_service_token_configured()

    assert "INTERNAL_SERVICE_TOKEN is required" in str(exc_info.value)


def test_startup_config_check_accepts_configured_token(monkeypatch):
    """Test that startup allows a configured internal service token."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "test-token-123")
    reset_settings()

    require_internal_service_token_configured()


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
