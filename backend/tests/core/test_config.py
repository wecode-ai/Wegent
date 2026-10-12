# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

import pytest
from pydantic import ValidationError
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource

from app.core.config import Settings, load_git_token_crypto_environment, settings


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
        assert s.DB_POOL_SIZE == 20
        assert s.DB_MAX_OVERFLOW == 40
        assert s.DB_ASYNC_POOL_SIZE == 10
        assert s.DB_ASYNC_MAX_OVERFLOW == 20
        assert s.DB_POOL_TIMEOUT == 30
        assert s.DB_POOL_RECYCLE == 3600

    @pytest.mark.parametrize(
        ("setting_name", "invalid_value"),
        [
            ("DB_POOL_SIZE", 0),
            ("DB_MAX_OVERFLOW", -1),
            ("DB_ASYNC_POOL_SIZE", 0),
            ("DB_ASYNC_MAX_OVERFLOW", -1),
            ("DB_POOL_TIMEOUT", 0),
            ("DB_POOL_RECYCLE", 0),
        ],
    )
    def test_database_pool_settings_reject_invalid_values(
        self,
        setting_name,
        invalid_value,
    ):
        with pytest.raises(ValidationError):
            build_settings(**{setting_name: invalid_value})

    @pytest.mark.parametrize(
        "setting_name",
        [
            "SOCKETIO_REDIS_SOCKET_TIMEOUT",
            "SOCKETIO_REDIS_CONNECT_TIMEOUT",
            "SOCKETIO_REDIS_HEALTH_CHECK_INTERVAL",
        ],
    )
    @pytest.mark.parametrize("invalid_value", [0, -1, float("inf")])
    def test_socketio_redis_settings_reject_unbounded_timeouts(
        self, setting_name: str, invalid_value: float
    ) -> None:
        with pytest.raises(ValidationError):
            build_settings(**{setting_name: invalid_value})

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

    def test_scheduled_tasks_switch_defaults_to_enabled_and_reads_environment(
        self, monkeypatch
    ):
        assert build_settings().SCHEDULED_TASKS_ENABLED is True

        monkeypatch.setenv("SCHEDULED_TASKS_ENABLED", "false")

        assert build_settings_from_env().SCHEDULED_TASKS_ENABLED is False

    def test_external_document_sync_defaults_to_disabled_and_reads_environment(
        self, monkeypatch
    ):
        assert build_settings().EXTERNAL_DOC_SYNC_ENABLED is False

        monkeypatch.setenv("EXTERNAL_DOC_SYNC_ENABLED", "true")

        assert build_settings_from_env().EXTERNAL_DOC_SYNC_ENABLED is True

    @pytest.mark.parametrize("invalid_value", [0, -1])
    def test_wiki_tree_page_limit_must_be_positive(self, invalid_value):
        with pytest.raises(ValidationError):
            build_settings(WIKI_TREE_MAX_PAGES=invalid_value)

    def test_plugin_publication_active_request_limit_must_be_positive(self):
        """Prevent capacity configuration from disabling publication globally."""
        with pytest.raises(
            ValidationError,
            match="WEWORK_PLUGIN_PUBLICATION_MAX_ACTIVE_REQUESTS must be at least 1",
        ):
            build_settings(WEWORK_PLUGIN_PUBLICATION_MAX_ACTIVE_REQUESTS=0)

    def test_wework_plugin_publication_settings_load_from_environment(
        self, monkeypatch
    ):
        """Keep the WeWork publication environment contract explicit."""
        monkeypatch.setenv(
            "WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID",
            "37282",
        )
        monkeypatch.setenv(
            "WEWORK_PLUGIN_PUBLICATION_GITLAB_WEBHOOK_SECRET",
            "webhook-secret",
        )
        monkeypatch.setenv("WEWORK_PLUGIN_RELEASE_KEY_MAX_DAYS", "90")

        s = build_settings_from_env()

        assert s.WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID == "37282"
        assert s.WEWORK_PLUGIN_PUBLICATION_GITLAB_WEBHOOK_SECRET == "webhook-secret"
        assert s.WEWORK_PLUGIN_RELEASE_KEY_MAX_DAYS == 90

    def test_git_token_crypto_environment_uses_dotenv_without_overriding_process_env(
        self, monkeypatch, tmp_path
    ):
        env_file = tmp_path / ".env"
        env_file.write_text(
            "GIT_TOKEN_AES_KEY=dotenv-key\nGIT_TOKEN_AES_IV=dotenv-iv\n",
            encoding="utf-8",
        )
        monkeypatch.delenv("GIT_TOKEN_AES_KEY", raising=False)
        monkeypatch.setenv("GIT_TOKEN_AES_IV", "process-iv")

        load_git_token_crypto_environment(env_file)

        assert os.environ["GIT_TOKEN_AES_KEY"] == "dotenv-key"
        assert os.environ["GIT_TOKEN_AES_IV"] == "process-iv"

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
        assert s.WORKSPACE_ARCHIVE_MAX_SIZE_MB == 2048
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

    def test_rag_runtime_mode_env_is_ignored(self, monkeypatch):
        """Test the deprecated RAG runtime mode variable no longer affects startup."""
        monkeypatch.setenv("RAG_RUNTIME_MODE", '{"default":"local",')

        s = build_settings_from_env()

        assert not hasattr(s, "RAG_RUNTIME_MODE")

    def test_rag_auto_disable_direct_injection_defaults_to_false(self):
        """Test the auto-routing direct injection kill switch defaults to disabled."""
        s = build_settings()

        assert s.RAG_AUTO_DISABLE_DIRECT_INJECTION is False

    def test_rag_auto_disable_direct_injection_accepts_true_env(self, monkeypatch):
        """Test the auto-routing direct injection kill switch accepts env override."""
        monkeypatch.setenv("RAG_AUTO_DISABLE_DIRECT_INJECTION", "true")

        s = build_settings_from_env()

        assert s.RAG_AUTO_DISABLE_DIRECT_INJECTION is True


@pytest.mark.unit
def test_database_timezone_is_read_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_TIMEZONE", "+05:30")

    configured = build_settings_from_env()

    assert configured.DATABASE_TIMEZONE == "+05:30"


@pytest.mark.unit
@pytest.mark.parametrize("offset", ["+00:00", "-05:30", "+05:45", "-13:59", "+14:00"])
def test_database_timezone_accepts_mysql_fixed_offsets(offset: str) -> None:
    assert build_settings(DATABASE_TIMEZONE=offset).DATABASE_TIMEZONE == offset


@pytest.mark.unit
@pytest.mark.parametrize(
    "offset",
    [
        "UTC",
        "SYSTEM",
        "Asia/Shanghai",
        "+08:60",
        "+14:01",
        "-14:00",
        "",
        "+08:00'; SELECT 1",
    ],
)
def test_database_timezone_rejects_invalid_or_named_offsets(offset: str) -> None:
    with pytest.raises(ValidationError, match="DATABASE_TIMEZONE"):
        build_settings(DATABASE_TIMEZONE=offset)


def test_database_timezone_default_preserves_existing_contract() -> None:
    assert build_settings().DATABASE_TIMEZONE == "+08:00"
