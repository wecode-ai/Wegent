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
    find_available_port,
    get_container_ports,
    get_docker_used_ports,
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
    def test_get_docker_used_ports_empty(self, mock_run):
        """Test getting Docker used ports when no containers running"""
        mock_run.return_value = MagicMock(stdout="", returncode=0)
        ports = get_docker_used_ports()
        assert len(ports) == 0

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

    @patch("subprocess.run")
    def test_delete_container_error(self, mock_run):
        """Test deleting container with error"""
        mock_run.side_effect = subprocess.CalledProcessError(
            1, "docker", stderr="error"
        )
        result = delete_container("test-container")
        assert result["status"] == "failed"
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
