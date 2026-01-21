# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import sys
from unittest.mock import MagicMock, patch

import pytest

from executor_manager.executors.base import Executor


class MockExecutor(Executor):
    """Mock executor for testing"""

    def submit_executor(self, task, callback=None):
        return {"status": "success"}

    def get_current_task_ids(self, label_selector=None):
        return {"task_ids": []}

    def delete_executor(self, pod_name):
        return {"status": "success"}

    def get_executor_count(self, label_selector=None):
        return {"count": 0}

    def get_container_address(self, executor_name):
        return {"status": "success", "base_url": "http://localhost:10001"}

    def get_container_status(self, executor_name):
        return {
            "exists": True,
            "status": "running",
            "oom_killed": False,
            "exit_code": 0,
            "error_msg": None,
        }


class TestExecutorDispatcher:
    """Test cases for ExecutorDispatcher"""

    def test_load_default_docker_executor(self):
        """Test loading default docker executor when EXECUTOR_CONFIG is empty"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", ""):
            from executor_manager.executors.dispatcher import ExecutorDispatcher

            executors = ExecutorDispatcher._load_executors()
            assert "docker" in executors
            assert executors["docker"] is not None

    def test_load_custom_executor_from_config(self):
        """Test loading custom executor from EXECUTOR_CONFIG"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        config = '{"custom": "executor_manager.tests.executors.test_dispatcher.MockExecutor"}'
        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", config):
            from executor_manager.executors.dispatcher import ExecutorDispatcher

            executors = ExecutorDispatcher._load_executors()
            assert "custom" in executors
            # Check that it's a MockExecutor by class name
            assert executors["custom"].__class__.__name__ == "MockExecutor"
            # Verify it has the expected methods
            assert hasattr(executors["custom"], "submit_executor")
            assert hasattr(executors["custom"], "get_current_task_ids")

    def test_load_executors_invalid_json(self):
        """Test that invalid JSON in EXECUTOR_CONFIG raises ValueError"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", "invalid json"):
            with pytest.raises(ValueError, match="Invalid JSON"):
                from executor_manager.executors.dispatcher import ExecutorDispatcher

    def test_load_executors_invalid_import_path(self):
        """Test that invalid import path raises error"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        config = '{"test": "invalid.path"}'
        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", config):
            with pytest.raises((ImportError, ValueError, RuntimeError)):
                from executor_manager.executors.dispatcher import ExecutorDispatcher

    def test_load_executors_nonexistent_module(self):
        """Test that nonexistent module raises RuntimeError"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        config = '{"test": "nonexistent.module.Class"}'
        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", config):
            with pytest.raises(RuntimeError):
                from executor_manager.executors.dispatcher import ExecutorDispatcher

    def test_get_executor_docker_type(self):
        """Test getting docker executor"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", ""):
            from executor_manager.executors.dispatcher import ExecutorDispatcher

            # Mock the _executors class variable
            mock_docker_executor = MockExecutor()
            with patch.object(
                ExecutorDispatcher, "_executors", {"docker": mock_docker_executor}
            ):
                executor = ExecutorDispatcher.get_executor("docker")
                assert executor is mock_docker_executor

    def test_get_executor_unknown_type_fallback_to_docker(self):
        """Test that unknown executor type falls back to docker"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", ""):
            from executor_manager.executors.dispatcher import ExecutorDispatcher

            mock_docker_executor = MockExecutor()
            with patch.object(
                ExecutorDispatcher, "_executors", {"docker": mock_docker_executor}
            ):
                executor = ExecutorDispatcher.get_executor("unknown_type")
                assert executor is mock_docker_executor

    def test_get_executor_unknown_type_no_docker_fallback(self):
        """Test that unknown executor type without docker fallback raises error"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", ""):
            from executor_manager.executors.dispatcher import ExecutorDispatcher

            with patch.object(
                ExecutorDispatcher, "_executors", {"custom": MockExecutor()}
            ):
                with pytest.raises(
                    ValueError, match="Default 'docker' executor not found"
                ):
                    ExecutorDispatcher.get_executor("unknown_type")

    def test_get_executor_custom_type(self):
        """Test getting custom executor type"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", ""):
            from executor_manager.executors.dispatcher import ExecutorDispatcher

            mock_custom_executor = MockExecutor()
            with patch.object(
                ExecutorDispatcher,
                "_executors",
                {"docker": MockExecutor(), "custom": mock_custom_executor},
            ):
                executor = ExecutorDispatcher.get_executor("custom")
                assert executor is mock_custom_executor

    def test_load_multiple_executors(self):
        """Test loading multiple executors from config"""
        # Clear module cache to force reimport
        for mod in list(sys.modules.keys()):
            if mod.startswith("executor_manager.executors"):
                del sys.modules[mod]

        config = '{"docker": "executor_manager.tests.executors.test_dispatcher.MockExecutor", "custom": "executor_manager.tests.executors.test_dispatcher.MockExecutor"}'
        # Patch config before importing dispatcher
        with patch("executor_manager.config.config.EXECUTOR_CONFIG", config):
            from executor_manager.executors.dispatcher import ExecutorDispatcher

            executors = ExecutorDispatcher._load_executors()
            assert "docker" in executors
            assert "custom" in executors
            # Check that they are MockExecutor by class name
            assert executors["docker"].__class__.__name__ == "MockExecutor"
            assert executors["custom"].__class__.__name__ == "MockExecutor"
            # Verify they have the expected methods
            assert hasattr(executors["docker"], "submit_executor")
            assert hasattr(executors["custom"], "submit_executor")
