# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

import pytest
from pydantic import ValidationError

from app.core.config import Settings, settings


@pytest.mark.unit
class TestSettings:
    """Test configuration settings"""

    def test_default_settings(self):
        """Test default settings values"""
        s = Settings()

        assert s.PROJECT_NAME == "Task Manager Backend"
        assert s.VERSION == "1.0.0"
        assert s.API_PREFIX == "/api"
        assert s.ENABLE_API_DOCS is True
        assert s.ALGORITHM == "HS256"
        assert s.ACCESS_TOKEN_EXPIRE_MINUTES == 10080  # 7 days

    def test_settings_from_env_variables(self, monkeypatch):
        """Test loading settings from environment variables"""
        monkeypatch.setenv("PROJECT_NAME", "Test Project")
        monkeypatch.setenv("API_PREFIX", "/test-api")
        monkeypatch.setenv("ACCESS_TOKEN_EXPIRE_MINUTES", "120")
        monkeypatch.setenv("ENABLE_API_DOCS", "false")

        s = Settings()

        assert s.PROJECT_NAME == "Test Project"
        assert s.API_PREFIX == "/test-api"
        assert s.ACCESS_TOKEN_EXPIRE_MINUTES == 120
        assert s.ENABLE_API_DOCS is False

    def test_settings_database_url(self):
        """Test database URL configuration"""
        s = Settings()

        assert s.DATABASE_URL is not None
        assert isinstance(s.DATABASE_URL, str)

    def test_settings_secret_key(self):
        """Test secret key configuration"""
        s = Settings()

        assert s.SECRET_KEY is not None
        assert isinstance(s.SECRET_KEY, str)
        assert len(s.SECRET_KEY) > 0

    def test_settings_redis_url(self):
        """Test Redis URL configuration"""
        s = Settings()

        assert s.REDIS_URL is not None
        assert s.REDIS_URL.startswith("redis://")

    def test_settings_executor_configuration(self):
        """Test executor configuration"""
        s = Settings()

        assert s.EXECUTOR_DELETE_TASK_URL is not None
        assert s.MAX_RUNNING_TASKS_PER_USER == 10

    def test_settings_task_expiration(self):
        """Test task expiration configuration"""
        s = Settings()

        assert s.APPEND_CHAT_TASK_EXPIRE_HOURS == 2
        assert s.APPEND_CODE_TASK_EXPIRE_HOURS == 24
        assert s.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS == 2
        assert s.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS == 24

    def test_settings_oidc_configuration(self):
        """Test OIDC configuration"""
        s = Settings()

        assert s.OIDC_CLIENT_ID is not None
        assert s.OIDC_CLIENT_SECRET is not None
        assert s.OIDC_DISCOVERY_URL is not None
        assert s.OIDC_REDIRECT_URI is not None

    def test_settings_cache_configuration(self):
        """Test cache configuration"""
        s = Settings()

        assert s.REPO_CACHE_EXPIRED_TIME == 7200
        assert s.REPO_UPDATE_INTERVAL_SECONDS == 3600

    def test_settings_share_token_encryption(self):
        """Test share token encryption configuration"""
        s = Settings()

        assert s.SHARE_TOKEN_AES_KEY is not None
        assert len(s.SHARE_TOKEN_AES_KEY) == 32  # AES-256 requires 32 bytes
        assert s.SHARE_TOKEN_AES_IV is not None
        assert len(s.SHARE_TOKEN_AES_IV) == 16  # AES IV requires 16 bytes

    def test_global_settings_instance(self):
        """Test global settings instance"""
        assert settings is not None
        assert isinstance(settings, Settings)

    def test_settings_immutability_after_creation(self):
        """Test that settings object is created correctly"""
        s = Settings()
        original_project_name = s.PROJECT_NAME

        # Create new instance with different values
        s2 = Settings(PROJECT_NAME="Different Project")

        # Original instance should remain unchanged
        assert s.PROJECT_NAME == original_project_name
        assert s2.PROJECT_NAME == "Different Project"

    def test_settings_with_custom_values(self):
        """Test creating settings with custom values"""
        s = Settings(
            PROJECT_NAME="Custom Project",
            ACCESS_TOKEN_EXPIRE_MINUTES=60,
            MAX_RUNNING_TASKS_PER_USER=5,
        )

        assert s.PROJECT_NAME == "Custom Project"
        assert s.ACCESS_TOKEN_EXPIRE_MINUTES == 60
        assert s.MAX_RUNNING_TASKS_PER_USER == 5
