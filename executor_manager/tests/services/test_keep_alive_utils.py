# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for keep_alive_utils module."""

from unittest.mock import MagicMock, patch

import pytest


class TestCheckKeepAliveProtection:
    """Tests for check_keep_alive_protection function."""

    def test_returns_false_for_docker_mode(self):
        """Test returns False when dispatcher mode is docker."""
        from executor_manager.services.keep_alive_utils import (
            check_keep_alive_protection,
        )

        result = check_keep_alive_protection("test-pod", "docker")
        assert result is False

    def test_returns_false_for_unknown_mode(self):
        """Test returns False when dispatcher mode is unknown."""
        from executor_manager.services.keep_alive_utils import (
            check_keep_alive_protection,
        )

        result = check_keep_alive_protection("test-pod", "unknown")
        assert result is False

    def test_returns_true_when_pod_has_label(self, mocker):
        """Test returns True when pod has keep-alive label in k8s mode."""
        from executor_manager.services.keep_alive_utils import (
            check_keep_alive_protection,
        )

        mock_executor = MagicMock()
        mock_executor.has_keep_alive_label.return_value = True
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        result = check_keep_alive_protection("test-pod", "k8s")

        assert result is True
        mock_executor.has_keep_alive_label.assert_called_once_with("test-pod")

    def test_returns_false_when_pod_lacks_label(self, mocker):
        """Test returns False when pod doesn't have keep-alive label."""
        from executor_manager.services.keep_alive_utils import (
            check_keep_alive_protection,
        )

        mock_executor = MagicMock()
        mock_executor.has_keep_alive_label.return_value = False
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        result = check_keep_alive_protection("test-pod", "k8s")

        assert result is False

    def test_returns_false_on_exception(self, mocker):
        """Test returns False when an exception occurs."""
        from executor_manager.services.keep_alive_utils import (
            check_keep_alive_protection,
        )

        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            side_effect=Exception("Connection error"),
        )

        result = check_keep_alive_protection("test-pod", "k8s")

        assert result is False

    def test_includes_log_context(self, mocker):
        """Test log context is included when checking protection."""
        from executor_manager.services.keep_alive_utils import (
            check_keep_alive_protection,
        )

        mock_executor = MagicMock()
        mock_executor.has_keep_alive_label.return_value = True
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        # Just verify the function runs without error with log_context
        result = check_keep_alive_protection("test-pod", "k8s", "[TestContext]")
        assert result is True


class TestSetKeepAliveProtection:
    """Tests for set_keep_alive_protection function."""

    def test_returns_skipped_for_docker_mode(self):
        """Test returns skipped status when dispatcher mode is docker."""
        from executor_manager.services.keep_alive_utils import set_keep_alive_protection

        result = set_keep_alive_protection("test-pod", "docker", True)

        assert result["status"] == "skipped"
        assert "only supported in Kubernetes" in result["error_msg"]

    def test_enables_protection_in_k8s_mode(self, mocker):
        """Test enables protection when called in k8s mode."""
        from executor_manager.services.keep_alive_utils import set_keep_alive_protection

        mock_executor = MagicMock()
        mock_executor.set_keep_alive_label.return_value = {
            "status": "success",
            "pod_name": "test-pod",
            "keep_alive": True,
        }
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        result = set_keep_alive_protection("test-pod", "k8s", True)

        assert result["status"] == "success"
        mock_executor.set_keep_alive_label.assert_called_once_with("test-pod", True)

    def test_disables_protection_in_k8s_mode(self, mocker):
        """Test disables protection when called with enabled=False."""
        from executor_manager.services.keep_alive_utils import set_keep_alive_protection

        mock_executor = MagicMock()
        mock_executor.set_keep_alive_label.return_value = {
            "status": "success",
            "pod_name": "test-pod",
            "keep_alive": False,
        }
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        result = set_keep_alive_protection("test-pod", "k8s", False)

        assert result["status"] == "success"
        mock_executor.set_keep_alive_label.assert_called_once_with("test-pod", False)

    def test_returns_failed_on_exception(self, mocker):
        """Test returns failed status when an exception occurs."""
        from executor_manager.services.keep_alive_utils import set_keep_alive_protection

        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            side_effect=Exception("Connection error"),
        )

        result = set_keep_alive_protection("test-pod", "k8s", True)

        assert result["status"] == "failed"
        assert "Connection error" in result["error_msg"]

    def test_handles_missing_method(self, mocker):
        """Test handles executor without set_keep_alive_label method."""
        from executor_manager.services.keep_alive_utils import set_keep_alive_protection

        mock_executor = MagicMock(spec=[])  # No methods
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        result = set_keep_alive_protection("test-pod", "k8s", True)

        assert result["status"] == "failed"
        assert "does not support" in result["error_msg"]
