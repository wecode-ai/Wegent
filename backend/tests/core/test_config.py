# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for app/core/config.py
"""

import pytest
from pydantic import ValidationError

from app.core.config import Settings


class TestSettings:
    """Test configuration settings"""

    def test_settings_default_values(self):
        """Test that settings have correct default values"""
        settings = Settings()

        assert settings.PROJECT_NAME == "Task Manager Backend"
        assert settings.VERSION == "1.0.0"
        assert settings.API_PREFIX == "/api"
        assert settings.ALGORITHM == "HS256"
        assert settings.ACCESS_TOKEN_EXPIRE_MINUTES == 24 * 60

    def test_settings_load_from_env(self, monkeypatch):
        """Test loading settings from environment variables"""
        monkeypatch.setenv("PROJECT_NAME", "Test Project")
        monkeypatch.setenv("API_PREFIX", "/test-api")
        monkeypatch.setenv("ACCESS_TOKEN_EXPIRE_MINUTES", "120")

        settings = Settings()

        assert settings.PROJECT_NAME == "Test Project"
        assert settings.API_PREFIX == "/test-api"
        assert settings.ACCESS_TOKEN_EXPIRE_MINUTES == 120

    def test_settings_database_url_default(self):
        """Test database URL has a default value"""
        settings = Settings()

        assert settings.DATABASE_URL is not None
        assert isinstance(settings.DATABASE_URL, str)

    def test_settings_jwt_configuration(self):
        """Test JWT configuration values"""
        settings = Settings()

        assert settings.SECRET_KEY is not None
        assert settings.ALGORITHM == "HS256"
        assert isinstance(settings.ACCESS_TOKEN_EXPIRE_MINUTES, int)

    def test_settings_oidc_configuration(self):
        """Test OIDC configuration values"""
        settings = Settings()

        assert settings.OIDC_CLIENT_ID is not None
        assert settings.OIDC_CLIENT_SECRET is not None
        assert settings.OIDC_DISCOVERY_URL is not None

    def test_settings_redis_url_default(self):
        """Test Redis URL has a default value"""
        settings = Settings()

        assert settings.REDIS_URL is not None
        assert "redis://" in settings.REDIS_URL

    def test_settings_task_limits(self):
        """Test task limit configurations"""
        settings = Settings()

        assert settings.MAX_RUNNING_TASKS_PER_USER == 10
        assert settings.APPEND_CHAT_TASK_EXPIRE_HOURS == 2
        assert settings.APPEND_CODE_TASK_EXPIRE_HOURS == 24

    def test_settings_enable_api_docs_default(self):
        """Test API docs is enabled by default"""
        settings = Settings()

        assert settings.ENABLE_API_DOCS is True

    def test_settings_enable_api_docs_from_env(self, monkeypatch):
        """Test API docs can be disabled via environment"""
        monkeypatch.setenv("ENABLE_API_DOCS", "false")

        settings = Settings()

        assert settings.ENABLE_API_DOCS is False
