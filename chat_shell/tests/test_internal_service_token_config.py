# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Backend internal service token configuration."""

from pathlib import Path

from chat_shell.core.config import Settings


def test_remote_storage_token_is_used_for_backend_internal_calls() -> None:
    settings = Settings(
        _env_file=None,
        REMOTE_STORAGE_TOKEN="remote-token",
        INTERNAL_SERVICE_TOKEN="internal-token",
    )

    assert settings.backend_internal_token == "remote-token"


def test_internal_service_token_is_remote_storage_fallback() -> None:
    settings = Settings(
        _env_file=None,
        REMOTE_STORAGE_TOKEN="",
        INTERNAL_SERVICE_TOKEN="internal-token",
    )

    assert settings.backend_internal_token == "internal-token"


def test_chat_history_retry_count_defaults_to_one() -> None:
    settings = Settings(_env_file=None)

    assert settings.CHAT_HISTORY_RETRY_COUNT == 1


def test_dotenv_path_is_independent_of_working_directory() -> None:
    assert Path(Settings.model_config["env_file"]).is_absolute()
