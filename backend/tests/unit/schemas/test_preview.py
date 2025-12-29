# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for preview schemas.
"""

import pytest

from app.schemas.preview import (
    PreviewConfig,
    PreviewConfigResponse,
    PreviewConfigSpec,
    PreviewStartResponse,
    PreviewStatus,
    PreviewStopResponse,
    ViewportSize,
)


class TestPreviewStatus:
    """Tests for PreviewStatus enum"""

    def test_status_values(self):
        """Test that all expected status values exist"""
        assert PreviewStatus.DISABLED.value == "disabled"
        assert PreviewStatus.STARTING.value == "starting"
        assert PreviewStatus.READY.value == "ready"
        assert PreviewStatus.ERROR.value == "error"
        assert PreviewStatus.STOPPED.value == "stopped"


class TestPreviewConfigSpec:
    """Tests for PreviewConfigSpec schema"""

    def test_parse_full_config(self):
        """Test parsing a full config with all fields"""
        data = {
            "enabled": True,
            "startCommand": "npm run dev",
            "port": 3000,
            "readyPattern": "Ready in",
            "workingDir": "./frontend",
            "env": {"NODE_ENV": "development"},
        }
        config = PreviewConfigSpec(**data)

        assert config.enabled is True
        assert config.start_command == "npm run dev"
        assert config.port == 3000
        assert config.ready_pattern == "Ready in"
        assert config.working_dir == "./frontend"
        assert config.env == {"NODE_ENV": "development"}

    def test_parse_minimal_config(self):
        """Test parsing a minimal config with required fields only"""
        data = {
            "startCommand": "npm start",
            "port": 8080,
            "readyPattern": "Listening",
        }
        config = PreviewConfigSpec(**data)

        assert config.enabled is True  # Default
        assert config.start_command == "npm start"
        assert config.port == 8080
        assert config.ready_pattern == "Listening"
        assert config.working_dir == "."  # Default
        assert config.env is None  # Optional

    def test_parse_with_camel_case(self):
        """Test that camelCase field names are properly aliased"""
        data = {
            "startCommand": "yarn dev",
            "port": 3001,
            "readyPattern": "Server running",
            "workingDir": ".",
        }
        config = PreviewConfigSpec(**data)

        # Access via snake_case
        assert config.start_command == "yarn dev"
        assert config.ready_pattern == "Server running"
        assert config.working_dir == "."


class TestPreviewConfig:
    """Tests for PreviewConfig schema"""

    def test_parse_full_yaml_config(self):
        """Test parsing a full .wegent.yaml config"""
        data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "ProjectConfig",
            "metadata": {"name": "my-app"},
            "spec": {
                "preview": {
                    "enabled": True,
                    "startCommand": "npm run dev",
                    "port": 3000,
                    "readyPattern": "Ready in",
                }
            },
        }
        config = PreviewConfig(**data)

        assert config.api_version == "agent.wecode.io/v1"
        assert config.kind == "ProjectConfig"
        assert config.metadata["name"] == "my-app"

        preview_spec = config.get_preview_spec()
        assert preview_spec is not None
        assert preview_spec.start_command == "npm run dev"
        assert preview_spec.port == 3000

    def test_get_preview_spec_missing(self):
        """Test get_preview_spec when preview section is missing"""
        data = {"spec": {}}
        config = PreviewConfig(**data)

        assert config.get_preview_spec() is None

    def test_get_preview_spec_invalid(self):
        """Test get_preview_spec when preview data is invalid"""
        data = {"spec": {"preview": {"invalid": "data"}}}
        config = PreviewConfig(**data)

        # Should return None for invalid config
        assert config.get_preview_spec() is None


class TestPreviewConfigResponse:
    """Tests for PreviewConfigResponse schema"""

    def test_response_enabled(self):
        """Test response when preview is enabled and ready"""
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

    def test_response_disabled(self):
        """Test response when preview is disabled"""
        response = PreviewConfigResponse(
            enabled=False,
            status=PreviewStatus.DISABLED,
            error="No .wegent.yaml found",
        )

        assert response.enabled is False
        assert response.status == PreviewStatus.DISABLED
        assert response.error == "No .wegent.yaml found"


class TestPreviewStartResponse:
    """Tests for PreviewStartResponse schema"""

    def test_successful_start(self):
        """Test response for successful start"""
        response = PreviewStartResponse(
            success=True,
            message="Preview service starting",
            status=PreviewStatus.STARTING,
            url="http://localhost:3000",
        )

        assert response.success is True
        assert response.status == PreviewStatus.STARTING

    def test_failed_start(self):
        """Test response for failed start"""
        response = PreviewStartResponse(
            success=False,
            message="Port already in use",
            status=PreviewStatus.ERROR,
        )

        assert response.success is False
        assert response.status == PreviewStatus.ERROR


class TestPreviewStopResponse:
    """Tests for PreviewStopResponse schema"""

    def test_successful_stop(self):
        """Test response for successful stop"""
        response = PreviewStopResponse(
            success=True,
            message="Preview service stopped",
        )

        assert response.success is True
        assert response.message == "Preview service stopped"


class TestViewportSize:
    """Tests for ViewportSize enum"""

    def test_viewport_values(self):
        """Test viewport size values"""
        assert ViewportSize.DESKTOP.value == "desktop"
        assert ViewportSize.TABLET.value == "tablet"
        assert ViewportSize.MOBILE.value == "mobile"
