# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

import pytest
from pydantic import ValidationError
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource

from app.core.config import Settings, settings


def build_settings(**kwargs) -> Settings:
    """Create settings using only explicit init values."""

    class InitOnlySettings(Settings):
        @classmethod
        def settings_customise_sources(
            cls,
            settings_cls: type[BaseSettings],
            init_settings: PydanticBaseSettingsSource,
            env_settings: PydanticBaseSettingsSource,
            dotenv_settings: PydanticBaseSettingsSource,
            file_secret_settings: PydanticBaseSettingsSource,
        ):
            del settings_cls, env_settings, dotenv_settings, file_secret_settings
            return (init_settings,)

    return InitOnlySettings(**kwargs)


def build_settings_from_env(**kwargs) -> Settings:
    """Create settings from explicit init values plus process environment."""

    class InitAndEnvSettings(Settings):
        @classmethod
        def settings_customise_sources(
            cls,
            settings_cls: type[BaseSettings],
            init_settings: PydanticBaseSettingsSource,
            env_settings: PydanticBaseSettingsSource,
            dotenv_settings: PydanticBaseSettingsSource,
            file_secret_settings: PydanticBaseSettingsSource,
        ):
            del settings_cls, dotenv_settings, file_secret_settings
            return (init_settings, env_settings)

    return InitAndEnvSettings(**kwargs)


@pytest.mark.unit
class TestSettings:
    """Test configuration settings"""

    def test_default_settings(self):
        """Test default settings values"""
        s = build_settings()

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

        s = build_settings_from_env()

        assert s.PROJECT_NAME == "Test Project"
        assert s.API_PREFIX == "/test-api"
        assert s.ACCESS_TOKEN_EXPIRE_MINUTES == 120
        assert s.ENABLE_API_DOCS is False

    def test_settings_database_url(self):
        """Test database URL configuration"""
        s = build_settings()

        assert s.DATABASE_URL is not None
        assert isinstance(s.DATABASE_URL, str)

    def test_settings_secret_key(self):
        """Test secret key configuration"""
        s = build_settings()

        assert s.SECRET_KEY is not None
        assert isinstance(s.SECRET_KEY, str)
        assert len(s.SECRET_KEY) > 0

    def test_settings_redis_url(self):
        """Test Redis URL configuration"""
        s = build_settings()

        assert s.REDIS_URL is not None
        assert s.REDIS_URL.startswith("redis://")

    def test_settings_executor_configuration(self):
        """Test executor configuration"""
        s = build_settings()

        assert s.EXECUTOR_DELETE_TASK_URL is not None
        assert s.MAX_RUNNING_TASKS_PER_USER == 10

    def test_settings_task_expiration(self):
        """Test task expiration configuration"""
        s = build_settings()

        assert s.APPEND_CHAT_TASK_EXPIRE_HOURS == 2
        assert s.APPEND_CODE_TASK_EXPIRE_HOURS == 24
        assert s.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS == 2
        assert s.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS == 24

    def test_workspace_archive_settings_defaults(self):
        """Test workspace archive configuration defaults."""
        s = build_settings()

        assert s.WORKSPACE_ARCHIVE_RETENTION_DAYS == 30
        assert s.WORKSPACE_ARCHIVE_BUCKET == "wegent-archives"
        assert s.WORKSPACE_ARCHIVE_MAX_SIZE_MB == 500
        assert s.WORKSPACE_ARCHIVE_ENABLED is True
        assert s.WORKSPACE_ARCHIVE_TIMEZONE == "Asia/Shanghai"

    def test_workspace_archive_settings_from_env(self, monkeypatch):
        """Test workspace archive configuration from environment variables."""
        monkeypatch.setenv("WORKSPACE_ARCHIVE_RETENTION_DAYS", "14")
        monkeypatch.setenv("WORKSPACE_ARCHIVE_BUCKET", "custom-archive-bucket")
        monkeypatch.setenv("WORKSPACE_ARCHIVE_MAX_SIZE_MB", "256")
        monkeypatch.setenv("WORKSPACE_ARCHIVE_ENABLED", "false")
        monkeypatch.setenv("WORKSPACE_ARCHIVE_TIMEZONE", "UTC")

        s = build_settings_from_env()

        assert s.WORKSPACE_ARCHIVE_RETENTION_DAYS == 14
        assert s.WORKSPACE_ARCHIVE_BUCKET == "custom-archive-bucket"
        assert s.WORKSPACE_ARCHIVE_MAX_SIZE_MB == 256
        assert s.WORKSPACE_ARCHIVE_ENABLED is False
        assert s.WORKSPACE_ARCHIVE_TIMEZONE == "UTC"

    def test_settings_oidc_configuration(self):
        """Test OIDC configuration"""
        s = build_settings()

        assert s.OIDC_CLIENT_ID is not None
        assert s.OIDC_CLIENT_SECRET is not None
        assert s.OIDC_DISCOVERY_URL is not None
        assert s.OIDC_REDIRECT_URI is not None

    def test_settings_cache_configuration(self):
        """Test cache configuration"""
        s = build_settings()

        assert s.REPO_CACHE_EXPIRED_TIME == 7200
        assert s.REPO_UPDATE_INTERVAL_SECONDS == 3600

    def test_settings_share_token_encryption(self):
        """Test share token encryption configuration"""
        s = build_settings()

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
        s = build_settings()
        original_project_name = s.PROJECT_NAME

        # Create new instance with different values
        s2 = build_settings(PROJECT_NAME="Different Project")

        # Original instance should remain unchanged
        assert s.PROJECT_NAME == original_project_name
        assert s2.PROJECT_NAME == "Different Project"

    def test_settings_with_custom_values(self):
        """Test creating settings with custom values"""
        s = build_settings(
            PROJECT_NAME="Custom Project",
            ACCESS_TOKEN_EXPIRE_MINUTES=60,
            MAX_RUNNING_TASKS_PER_USER=5,
        )

        assert s.PROJECT_NAME == "Custom Project"
        assert s.ACCESS_TOKEN_EXPIRE_MINUTES == 60
        assert s.MAX_RUNNING_TASKS_PER_USER == 5

    def test_rag_runtime_mode_defaults_to_local_for_all_operations(self):
        """Test RAG runtime mode defaults to local across operations."""
        s = build_settings()

        assert s.RAG_RUNTIME_MODE == "local"
        assert s.get_rag_runtime_mode("index") == "local"
        assert s.get_rag_runtime_mode("query") == "local"
        assert s.get_rag_runtime_mode("delete") == "local"

    def test_rag_runtime_mode_accepts_global_env_value(self, monkeypatch):
        """Test RAG runtime mode accepts a single global env value."""
        monkeypatch.setenv("RAG_RUNTIME_MODE", "remote")

        s = build_settings_from_env()

        assert s.RAG_RUNTIME_MODE == "remote"
        assert s.get_rag_runtime_mode("index") == "remote"
        assert s.get_rag_runtime_mode("query") == "remote"
        assert s.get_rag_runtime_mode("delete") == "remote"

    def test_rag_runtime_mode_accepts_operation_override_map(self, monkeypatch):
        """Test RAG runtime mode accepts per-operation overrides."""
        monkeypatch.setenv(
            "RAG_RUNTIME_MODE",
            '{"default":"remote","query":"local"}',
        )

        s = build_settings_from_env()

        assert s.RAG_RUNTIME_MODE == {"default": "remote", "query": "local"}
        assert s.get_rag_runtime_mode("index") == "remote"
        assert s.get_rag_runtime_mode("query") == "local"
        assert s.get_rag_runtime_mode("delete") == "remote"

    def test_rag_runtime_mode_rejects_unknown_global_value(self, monkeypatch):
        """Test invalid global RAG runtime modes fail fast."""
        monkeypatch.setenv("RAG_RUNTIME_MODE", "edge")

        with pytest.raises(ValidationError, match="Invalid RAG runtime mode"):
            build_settings_from_env()

    def test_rag_runtime_mode_rejects_invalid_operation_override_value(
        self, monkeypatch
    ):
        """Test invalid per-operation runtime modes fail fast."""
        monkeypatch.setenv(
            "RAG_RUNTIME_MODE",
            '{"default":"remote","query":"edge"}',
        )

        with pytest.raises(ValidationError, match="Invalid RAG runtime mode"):
            build_settings_from_env()

    def test_rag_runtime_mode_rejects_malformed_json_override(self, monkeypatch):
        """Test malformed JSON override maps are rejected."""
        monkeypatch.setenv("RAG_RUNTIME_MODE", '{"default":"remote",')

        with pytest.raises(ValidationError, match="malformed"):
            build_settings_from_env()

    def test_rag_auto_disable_direct_injection_defaults_to_false(self):
        """Test the auto-routing direct injection kill switch defaults to disabled."""
        s = build_settings()

        assert s.RAG_AUTO_DISABLE_DIRECT_INJECTION is False

    def test_rag_auto_disable_direct_injection_accepts_true_env(self, monkeypatch):
        """Test the auto-routing direct injection kill switch accepts env override."""
        monkeypatch.setenv("RAG_AUTO_DISABLE_DIRECT_INJECTION", "true")

        s = build_settings_from_env()

        assert s.RAG_AUTO_DISABLE_DIRECT_INJECTION is True
