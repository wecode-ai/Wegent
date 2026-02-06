# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for env_reader module.
"""

import json
import os
import tempfile
from unittest.mock import patch

import pytest

from executor.config.env_reader import (
    get_env,
    get_env_json,
    get_task_info,
)


class TestGetEnv:
    """Tests for get_env function."""

    def test_returns_env_var_when_set(self):
        """Should return environment variable value when set."""
        with patch.dict(os.environ, {"TEST_KEY": "env_value"}):
            result = get_env("TEST_KEY")
            assert result == "env_value"

    def test_returns_file_content_when_env_not_set(self):
        """Should return file content when env var not set."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create config file
            file_path = os.path.join(tmpdir, "test_key")
            with open(file_path, "w") as f:
                f.write("file_value")

            # Clear env var and set config dir
            with patch.dict(os.environ, {"WEGENT_CONFIG_DIR": tmpdir}, clear=False):
                # Remove the env var if it exists
                env_copy = os.environ.copy()
                env_copy.pop("TEST_KEY", None)
                with patch.dict(os.environ, env_copy, clear=True):
                    with patch.dict(os.environ, {"WEGENT_CONFIG_DIR": tmpdir}):
                        result = get_env("TEST_KEY")
                        assert result == "file_value"

    def test_returns_default_when_neither_exists(self):
        """Should return default when neither env var nor file exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"WEGENT_CONFIG_DIR": tmpdir}, clear=True):
                result = get_env("NONEXISTENT_KEY", "default_value")
                assert result == "default_value"

    def test_env_var_takes_precedence_over_file(self):
        """Environment variable should take precedence over file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create config file
            file_path = os.path.join(tmpdir, "test_key")
            with open(file_path, "w") as f:
                f.write("file_value")

            with patch.dict(
                os.environ, {"TEST_KEY": "env_value", "WEGENT_CONFIG_DIR": tmpdir}
            ):
                result = get_env("TEST_KEY")
                assert result == "env_value"

    def test_strips_whitespace_from_file_content(self):
        """Should strip whitespace from file content."""
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = os.path.join(tmpdir, "test_key")
            with open(file_path, "w") as f:
                f.write("  value_with_spaces  \n")

            with patch.dict(os.environ, {"WEGENT_CONFIG_DIR": tmpdir}, clear=True):
                result = get_env("TEST_KEY")
                assert result == "value_with_spaces"


class TestGetEnvJson:
    """Tests for get_env_json function."""

    def test_parses_valid_json_from_env(self):
        """Should parse valid JSON from environment variable."""
        json_data = {"key": "value", "number": 123}
        with patch.dict(os.environ, {"JSON_KEY": json.dumps(json_data)}):
            result = get_env_json("JSON_KEY")
            assert result == json_data

    def test_returns_default_for_invalid_json(self):
        """Should return default for invalid JSON."""
        with patch.dict(os.environ, {"INVALID_JSON": "not valid json"}):
            result = get_env_json("INVALID_JSON", {"default": True})
            assert result == {"default": True}

    def test_returns_default_when_not_found(self):
        """Should return default when key not found."""
        with patch.dict(os.environ, {}, clear=True):
            with patch.dict(os.environ, {"WEGENT_CONFIG_DIR": "/nonexistent"}):
                result = get_env_json("MISSING_KEY", {"default": True})
                assert result == {"default": True}


class TestGetTaskInfo:
    """Tests for get_task_info function."""

    def test_returns_task_info_from_env(self):
        """Should return task info from TASK_INFO env var."""
        task_data = {"task_id": 123, "subtask_id": 456}
        with patch.dict(os.environ, {"TASK_INFO": json.dumps(task_data)}):
            result = get_task_info()
            assert result == task_data

    def test_returns_task_info_from_file(self):
        """Should return task info from file when env var not set."""
        with tempfile.TemporaryDirectory() as tmpdir:
            task_data = {"task_id": 789, "subtask_id": 101}
            file_path = os.path.join(tmpdir, "task_info")
            with open(file_path, "w") as f:
                f.write(json.dumps(task_data))

            with patch.dict(os.environ, {"WEGENT_CONFIG_DIR": tmpdir}, clear=True):
                result = get_task_info()
                assert result == task_data

    def test_returns_none_when_not_found(self):
        """Should return None when task info not found."""
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"WEGENT_CONFIG_DIR": tmpdir}, clear=True):
                result = get_task_info()
                assert result is None
