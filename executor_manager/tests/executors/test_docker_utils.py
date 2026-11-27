# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import subprocess
from unittest.mock import MagicMock, patch

import pytest

from executor_manager.executors.docker.utils import (
    build_callback_url,
    check_container_ownership,
    count_running_containers,
    delete_container,
    get_container_ports,
    get_running_task_details,
)


class TestDockerUtils:
    """Test cases for Docker utility functions"""

    def test_build_callback_url_from_task(self):
        """Test building callback URL from task"""
        task = {"callback_url": "http://custom.callback.url"}
        url = build_callback_url(task)
        assert url == "http://custom.callback.url"

    @patch.dict("os.environ", {"CALLBACK_URL": "http://env.callback.url"}, clear=False)
    def test_build_callback_url_from_env(self):
        """Test building callback URL from environment variable"""
        task = {}
        url = build_callback_url(task)
        assert url == "http://env.callback.url"

    @pytest.mark.parametrize(
        ("docker_env", "expected"),
        [
            ({}, "http://localhost:8001/executor-manager/callback"),
            (
                {"CALLBACK_HOST": "http://192.168.1.100:8001"},
                "http://192.168.1.100:8001/executor-manager/callback",
            ),
            (
                {
                    "CALLBACK_HOST": "http://192.168.1.100:8001",
                    "CALLBACK_URL": "http://docker-manager/executor-manager/callback",
                },
                "http://docker-manager/executor-manager/callback",
            ),
        ],
    )
    def test_credentialed_callback_uses_docker_address(self, docker_env, expected):
        task = {
            "metadata": {
                "task_id": 42,
                "callback_url": "http://custom.callback.url",
                "executor_callback_token": "test-credential",
            }
        }
        manager_url = "http://localhost:8001/executor-manager/callback"
        with patch.dict(
            "os.environ",
            {"EXECUTOR_MANAGER_CALLBACK_URL": manager_url, **docker_env},
            clear=True,
        ):
            assert build_callback_url(task) == expected

    @patch.dict(
        "os.environ",
        {"CALLBACK_HOST": "192.168.1.100", "CALLBACK_PORT": "9090"},
        clear=False,
    )
    @patch("executor_manager.executors.docker.utils.get_host_ip")
    def test_build_callback_url_from_host_and_port(self, mock_get_ip):
        """Test building callback URL from host and port"""
        mock_get_ip.return_value = "192.168.1.100"
        task = {}
        url = build_callback_url(task)
        assert "192.168.1.100:9090" in url
        assert "/executor-manager/callback" in url

    @patch.dict(
        "os.environ",
        {"CALLBACK_HOST": "example.com", "CALLBACK_PORT": "8080"},
        clear=False,
    )
    @patch("executor_manager.executors.docker.utils.get_host_ip")
    @patch("executor_manager.executors.docker.utils.is_ip_address")
    def test_build_callback_url_with_domain(self, mock_is_ip, mock_get_ip):
        """Test building callback URL with domain name"""
        mock_get_ip.return_value = "example.com"
        mock_is_ip.return_value = False
        task = {}
        url = build_callback_url(task)
        assert "example.com" in url
        assert "/executor-manager/callback" in url

    @patch("subprocess.run")
    def test_check_container_ownership_true(self, mock_run):
        """Test checking container ownership when owned"""
        mock_run.return_value = MagicMock(stdout="test-container\n", returncode=0)
        result = check_container_ownership("test-container")
        assert result is True

    @patch("subprocess.run")
    def test_check_container_ownership_false(self, mock_run):
        """Test checking container ownership when not owned"""
        mock_run.return_value = MagicMock(stdout="", returncode=0)
        result = check_container_ownership("test-container")
        assert result is False

    @patch("subprocess.run")
    def test_check_container_ownership_error(self, mock_run):
        """Test checking container ownership with error"""
        mock_run.side_effect = subprocess.CalledProcessError(
            1, "docker", stderr="error"
        )
        result = check_container_ownership("test-container")
        assert result is False

    @patch("subprocess.run")
    def test_delete_container_success(self, mock_run):
        """Test deleting container successfully"""
        mock_run.return_value = MagicMock(returncode=0)
        result = delete_container("test-container")
        assert result["status"] == "success"
        assert [call.args[0] for call in mock_run.call_args_list] == [
            ["docker", "stop", "--", "test-container"],
            ["docker", "rm", "--", "test-container"],
        ]

    @pytest.mark.parametrize(
        ("inspect_error", "status"),
        [
            ("Error: No such object: test-container", "not_found"),
            ("API unavailable", "failed"),
        ],
    )
    @patch("subprocess.run")
    def test_delete_container_error(self, mock_run, inspect_error, status):
        """A delete failure is conclusive only when Docker confirms absence."""
        mock_run.side_effect = [
            subprocess.CalledProcessError(1, "docker", stderr="error"),
            MagicMock(returncode=1, stderr=inspect_error),
        ]
        result = delete_container("test-container")
        assert result["status"] == status
        if status == "failed":
            assert "error" in result["error_msg"]

    @patch("subprocess.run")
    def test_get_container_ports_success(self, mock_run):
        """Test getting container ports successfully"""
        # First call: check_container_ownership
        # Second call: get ports
        mock_run.side_effect = [
            MagicMock(stdout="test-container\n", returncode=0),  # ownership check
            MagicMock(stdout="0.0.0.0:8080->8080/tcp\n", returncode=0),  # get ports
        ]
        result = get_container_ports("test-container")
        assert result["status"] == "success"
        assert len(result["ports"]) == 1
        assert result["ports"][0]["host_port"] == 8080
        assert result["ports"][0]["container_port"] == 8080
        assert result["ports"][0]["protocol"] == "tcp"

    @patch("executor_manager.executors.docker.utils.check_container_ownership")
    def test_get_container_ports_not_owned(self, mock_check):
        """Test getting container ports when not owned"""
        mock_check.return_value = False
        result = get_container_ports("test-container")
        assert result["status"] == "failed"
        assert "not found or not owned" in result["error_msg"]

    @patch("subprocess.run")
    def test_count_running_containers_success(self, mock_run):
        """Test counting running containers successfully"""
        mock_run.return_value = MagicMock(
            stdout="container1\ncontainer2\ncontainer3\n", returncode=0
        )
        result = count_running_containers()
        assert result["status"] == "success"
        assert result["count"] == 3

    @patch("subprocess.run")
    def test_count_running_containers_with_label_selector(self, mock_run):
        """Test counting running containers with label selector"""
        mock_run.return_value = MagicMock(stdout="container1\n", returncode=0)
        result = count_running_containers(label_selector="task_id=123")
        assert result["status"] == "success"
        assert result["count"] == 1

    @patch("subprocess.run")
    def test_count_running_containers_error(self, mock_run):
        """Test counting running containers with error"""
        mock_run.side_effect = Exception("Docker error")
        result = count_running_containers()
        assert result["status"] == "failed"
        assert result["count"] == 0

    @patch("subprocess.run")
    def test_get_running_task_details_success(self, mock_run):
        """Test getting running task details successfully"""
        mock_run.return_value = MagicMock(
            stdout="123|456|789|online|container1\n124|457||online|container2\n",
            returncode=0,
        )
        result = get_running_task_details()
        assert result["status"] == "success"
        assert "123" in result["task_ids"]
        assert "124" not in result["task_ids"]  # Has empty subtask_next_id
        assert len(result["containers"]) == 2

    @patch("subprocess.run")
    def test_get_running_task_details_with_label_selector(self, mock_run):
        """Test getting running task details with label selector"""
        mock_run.return_value = MagicMock(
            stdout="123|456|789|online|container1\n", returncode=0
        )
        result = get_running_task_details(label_selector="task_id=123")
        assert result["status"] == "success"
        assert len(result["task_ids"]) == 1

    @patch("subprocess.run")
    def test_get_running_task_details_empty(self, mock_run):
        """Test getting running task details when no containers"""
        mock_run.return_value = MagicMock(stdout="", returncode=0)
        result = get_running_task_details()
        assert result["status"] == "success"
        assert len(result["task_ids"]) == 0
        assert len(result["containers"]) == 0

    @patch("subprocess.run")
    def test_get_running_task_details_error(self, mock_run):
        """Test getting running task details with error"""
        mock_run.side_effect = Exception("Docker error")
        result = get_running_task_details()
        assert result["status"] == "failed"
        assert len(result["task_ids"]) == 0

    @patch("subprocess.run")
    def test_get_running_task_details_multiple_containers_same_task(self, mock_run):
        """Test getting running task details with multiple containers for same task"""
        mock_run.return_value = MagicMock(
            stdout="123|456|789|online|container1\n123|457|790|online|container2\n",
            returncode=0,
        )
        result = get_running_task_details()
        assert result["status"] == "success"
        assert "123" in result["task_ids"]
        assert len(result["containers"]) == 2

    @patch("subprocess.run")
    def test_get_running_task_details_task_completed(self, mock_run):
        """Test getting running task details with completed task"""
        # Task 123 has one container with empty subtask_next_id (completed)
        mock_run.return_value = MagicMock(
            stdout="123|456||online|container1\n124|457|789|online|container2\n",
            returncode=0,
        )
        result = get_running_task_details()
        assert result["status"] == "success"
        assert "123" not in result["task_ids"]  # Task 123 is completed
        assert "124" in result["task_ids"]  # Task 124 is still running


def test_running_docker_callback_renewal_recovers_only_owned_runtime(mocker):
    from executor_manager.executors.docker import utils

    token = "a" * 64
    repository = mocker.patch(
        "executor_manager.services.sandbox.repository.get_sandbox_repository"
    ).return_value
    docker = mocker.patch.object(
        utils.subprocess,
        "run",
        side_effect=[
            mocker.Mock(
                stdout=(
                    "active-id sandbox-id old-sandbox-id validation-id "
                    "exited-id foreign-id legacy-id"
                )
            ),
            mocker.Mock(
                stdout="\n".join(
                    [
                        f'true /active executor_manager 42 ["EXECUTOR_CALLBACK_TOKEN={token}", "EXECUTOR_CALLBACK_SCOPE=task", "HEARTBEAT_TYPE=sandbox"]',
                        f'true /sandbox executor_manager 42 ["EXECUTOR_CALLBACK_TOKEN={token}", "EXECUTOR_CALLBACK_SCOPE=sandbox"]',
                        f'true /old-sandbox executor_manager 46 ["EXECUTOR_CALLBACK_TOKEN={token}", "HEARTBEAT_TYPE=sandbox"]',
                        f'true /validation executor_manager -47 ["EXECUTOR_CALLBACK_TOKEN={token}", "EXECUTOR_CALLBACK_SCOPE=task"]',
                        f'false /exited executor_manager 43 ["EXECUTOR_CALLBACK_TOKEN={token}"]',
                        f'true /foreign other-owner 44 ["EXECUTOR_CALLBACK_TOKEN={token}"]',
                        'true /legacy executor_manager 45 ["OTHER=true"]',
                    ]
                )
            ),
        ],
    )

    utils.renew_running_docker_callback_bindings()

    assert "label=owner=executor_manager" in docker.call_args_list[0].args[0]
    assert repository.renew_docker_callback_binding.call_args_list == [
        mocker.call(42, "active", token, sandbox=False),
        mocker.call(42, "sandbox", token, sandbox=True),
        mocker.call(46, "old-sandbox", token, sandbox=True),
        mocker.call(-47, "validation", token, sandbox=False),
    ]
