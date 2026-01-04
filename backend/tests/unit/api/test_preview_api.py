# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for preview API endpoints - Only schema-based tests.

Note: Full API integration tests require the test fixtures from conftest.py.
These tests focus on schema validation and response structure.
"""

import pytest

from app.schemas.preview import (
    PreviewConfigResponse,
    PreviewStartResponse,
    PreviewStatus,
    PreviewStopResponse,
)


class TestPreviewApiSchemas:
    """Tests for preview API response schemas"""

    def test_preview_config_response_disabled(self):
        """Test PreviewConfigResponse for disabled state"""
        response = PreviewConfigResponse(
            enabled=False,
            status=PreviewStatus.DISABLED,
            error="Task not found",
        )

        assert response.enabled is False
        assert response.status == PreviewStatus.DISABLED
        assert response.error == "Task not found"
        assert response.port is None
        assert response.url is None

    def test_preview_config_response_enabled(self):
        """Test PreviewConfigResponse for enabled and ready state"""
        response = PreviewConfigResponse(
            enabled=True,
            port=3000,
            status=PreviewStatus.READY,
            url="http://localhost:3000",
            start_command="npm run dev",
            ready_pattern="Ready in",
        )

        assert response.enabled is True
        assert response.port == 3000
        assert response.status == PreviewStatus.READY
        assert response.url == "http://localhost:3000"
        assert response.start_command == "npm run dev"
        assert response.ready_pattern == "Ready in"

    def test_preview_start_response_success(self):
        """Test PreviewStartResponse for successful start"""
        response = PreviewStartResponse(
            success=True,
            message="Preview service starting",
            status=PreviewStatus.STARTING,
            url="http://localhost:3000",
        )

        assert response.success is True
        assert response.message == "Preview service starting"
        assert response.status == PreviewStatus.STARTING
        assert response.url == "http://localhost:3000"

    def test_preview_start_response_failure(self):
        """Test PreviewStartResponse for failed start"""
        response = PreviewStartResponse(
            success=False,
            message="Port already in use",
            status=PreviewStatus.ERROR,
        )

        assert response.success is False
        assert response.message == "Port already in use"
        assert response.status == PreviewStatus.ERROR
        assert response.url is None

    def test_preview_stop_response(self):
        """Test PreviewStopResponse"""
        response = PreviewStopResponse(
            success=True,
            message="Preview service stopped",
        )

        assert response.success is True
        assert response.message == "Preview service stopped"

    def test_response_serialization(self):
        """Test that responses serialize correctly to dict/JSON"""
        response = PreviewConfigResponse(
            enabled=True,
            port=3000,
            status=PreviewStatus.READY,
            url="http://localhost:3000",
        )

        data = response.model_dump()
        assert data["enabled"] is True
        assert data["port"] == 3000
        assert data["status"] == "ready"
        assert data["url"] == "http://localhost:3000"
