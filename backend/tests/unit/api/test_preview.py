# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for preview API endpoints.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.preview import PreviewConfigResponse, PreviewStartResponse, PreviewStatus


@pytest.fixture
def mock_current_user():
    """Create a mock current user"""
    from app.models.user import User

    user = User()
    user.id = 1
    user.name = "testuser"
    user.email = "test@example.com"
    return user


@pytest.fixture
def client():
    """Create a test client"""
    return TestClient(app)


class TestPreviewEndpoints:
    """Tests for preview API endpoints"""

    @pytest.mark.asyncio
    async def test_get_preview_config_not_found(self, client, mock_current_user):
        """Test getting preview config for non-existent task"""
        with patch("app.api.endpoints.preview.security.get_current_user") as mock_auth:
            mock_auth.return_value = mock_current_user

            with patch(
                "app.api.endpoints.preview.preview_service.get_preview_config"
            ) as mock_service:
                mock_service.return_value = PreviewConfigResponse(
                    enabled=False,
                    status=PreviewStatus.DISABLED,
                    error="Task not found",
                )

                response = client.get(
                    "/api/preview/999/config",
                    headers={"Authorization": "Bearer test-token"},
                )

                assert response.status_code == 200
                data = response.json()
                assert data["enabled"] is False
                assert data["status"] == "disabled"

    @pytest.mark.asyncio
    async def test_get_preview_config_enabled(self, client, mock_current_user):
        """Test getting preview config when preview is enabled"""
        with patch("app.api.endpoints.preview.security.get_current_user") as mock_auth:
            mock_auth.return_value = mock_current_user

            with patch(
                "app.api.endpoints.preview.preview_service.get_preview_config"
            ) as mock_service:
                mock_service.return_value = PreviewConfigResponse(
                    enabled=True,
                    port=3000,
                    status=PreviewStatus.READY,
                    url="http://localhost:3000",
                    start_command="npm run dev",
                    ready_pattern="Ready in",
                )

                response = client.get(
                    "/api/preview/1/config",
                    headers={"Authorization": "Bearer test-token"},
                )

                assert response.status_code == 200
                data = response.json()
                assert data["enabled"] is True
                assert data["port"] == 3000
                assert data["status"] == "ready"

    @pytest.mark.asyncio
    async def test_start_preview_success(self, client, mock_current_user):
        """Test starting preview service successfully"""
        with patch("app.api.endpoints.preview.security.get_current_user") as mock_auth:
            mock_auth.return_value = mock_current_user

            with patch(
                "app.api.endpoints.preview.preview_service.start_preview"
            ) as mock_service:
                mock_service.return_value = PreviewStartResponse(
                    success=True,
                    message="Preview service starting",
                    status=PreviewStatus.STARTING,
                    url="http://localhost:3000",
                )

                response = client.post(
                    "/api/preview/1/start",
                    headers={"Authorization": "Bearer test-token"},
                    json={"force": False},
                )

                assert response.status_code == 200
                data = response.json()
                assert data["success"] is True
                assert data["status"] == "starting"

    @pytest.mark.asyncio
    async def test_stop_preview_success(self, client, mock_current_user):
        """Test stopping preview service successfully"""
        with patch("app.api.endpoints.preview.security.get_current_user") as mock_auth:
            mock_auth.return_value = mock_current_user

            with patch(
                "app.api.endpoints.preview.preview_service.stop_preview"
            ) as mock_service:
                mock_service.return_value = {"success": True, "message": "Stopped"}

                response = client.post(
                    "/api/preview/1/stop",
                    headers={"Authorization": "Bearer test-token"},
                )

                assert response.status_code == 200
                data = response.json()
                assert data["success"] is True
