# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import subprocess
from unittest.mock import MagicMock, Mock, call, patch

import pytest

from executor_manager.executors.docker.executor import DockerExecutor
from shared.status import TaskStatus


class TestDockerExecutor:
    """Test cases for DockerExecutor"""

    @pytest.fixture
    def mock_subprocess(self):
        """Mock subprocess module"""
        mock = MagicMock()
        mock.run = MagicMock()
        mock.CalledProcessError = subprocess.CalledProcessError
        mock.SubprocessError = subprocess.SubprocessError
        return mock

    @pytest.fixture
    def mock_requests(self):
        """Mock requests module"""
        mock = MagicMock()
        return mock

    @pytest.fixture
    def executor(self, mock_subprocess, mock_requests):
        """Create DockerExecutor instance with mocked dependencies"""
        # Mock docker availability check
        mock_subprocess.run.return_value = MagicMock(returncode=0)
        return DockerExecutor(
            subprocess_module=mock_subprocess, requests_module=mock_requests
        )

    @pytest.fixture
    def sample_task(self):
        """Sample task data"""
        return {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_image": "test/executor:latest",
            "mode": "code",
            "type": "online",
        }

    def test_init_docker_available(self, mock_subprocess, mock_requests):
        """Test initialization when Docker is available"""
        mock_subprocess.run.return_value = MagicMock(returncode=0)
        executor = DockerExecutor(
            subprocess_module=mock_subprocess, requests_module=mock_requests
        )
        assert executor is not None
        mock_subprocess.run.assert_called_once()

    def test_init_docker_not_available(self, mock_subprocess, mock_requests):
        """Test initialization when Docker is not available"""
        mock_subprocess.run.side_effect = FileNotFoundError("docker not found")
        with pytest.raises(RuntimeError, match="Docker is not available"):
            DockerExecutor(
                subprocess_module=mock_subprocess, requests_module=mock_requests
            )

    def test_extract_task_info(self, executor, sample_task):
        """Test extracting task information"""
        info = executor._extract_task_info(sample_task)
        assert info["task_id"] == 123
        assert info["subtask_id"] == 456
        assert info["user_name"] == "test_user"
        assert info["executor_name"] is None

    def test_extract_task_info_with_executor_name(self, executor):
        """Test extracting task info with existing executor name"""
        task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_name": "existing-executor",
        }
        info = executor._extract_task_info(task)
        assert info["executor_name"] == "existing-executor"

    def test_extract_task_info_defaults(self, executor):
        """Test extracting task info with missing fields"""
        task = {}
        info = executor._extract_task_info(task)
        assert info["task_id"] == -1
        assert info["subtask_id"] == -1
        assert info["user_name"] == "unknown"

    def test_get_executor_image_from_task(self, executor, sample_task):
        """Test getting executor image from task"""
        image = executor._get_executor_image(sample_task)
        assert image == "test/executor:latest"

    def test_get_executor_image_missing(self, executor):
        """Test getting executor image when missing"""
        task = {}
        with pytest.raises(ValueError, match="Executor image not provided"):
            executor._get_executor_image(task)

    @patch("executor_manager.executors.docker.utils.get_docker_used_ports")
    @patch("executor_manager.executors.docker.executor.build_callback_url")
    def test_prepare_docker_command(
        self, mock_callback, mock_get_ports, executor, sample_task
    ):
        """Test preparing Docker run command"""
        # Mock get_docker_used_ports to avoid actual Docker command execution
        mock_get_ports.return_value = set()
        mock_callback.return_value = "http://callback.url"

        task_info = executor._extract_task_info(sample_task)
        executor_name = "test-executor"
        executor_image = "test/executor:latest"

        cmd = executor._prepare_docker_command(
            sample_task, task_info, executor_name, executor_image
        )

        assert "docker" in cmd
        assert "run" in cmd
        assert "-d" in cmd
        assert "--name" in cmd
        assert executor_name in cmd
        assert executor_image in cmd
        assert any("task_id=123" in str(item) for item in cmd)
        assert any("subtask_id=456" in str(item) for item in cmd)

    @patch("executor_manager.executors.docker.utils.subprocess.run")
    def test_submit_executor_existing_container_success(
        self, mock_run, executor, mock_requests
    ):
        """Test submitting executor to existing container successfully"""
        task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_name": "existing-executor",
        }

        # Mock subprocess.run calls:
        # 1. check_container_ownership
        # 2. get_container_ports
        mock_run.side_effect = [
            MagicMock(stdout="existing-executor\n", returncode=0),  # ownership check
            MagicMock(stdout="0.0.0.0:8080->8080/tcp\n", returncode=0),  # get ports
        ]

        mock_response = MagicMock()
        mock_response.json.return_value = {"status": "success"}
        mock_requests.post.return_value = mock_response

        result = executor.submit_executor(task)

        assert result["status"] == "success"
        assert result["executor_name"] == "existing-executor"

    @patch("executor_manager.executors.docker.utils.subprocess.run")
    def test_submit_executor_existing_container_no_ports(self, mock_run, executor):
        """Test submitting executor to existing container with no ports"""
        task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_name": "existing-executor",
        }

        # Mock subprocess.run calls:
        # 1. check_container_ownership - container exists
        # 2. get_container_ports - no ports found (empty output)
        mock_run.side_effect = [
            MagicMock(stdout="existing-executor\n", returncode=0),  # ownership check
            MagicMock(stdout="", returncode=0),  # get ports - empty
        ]

        result = executor.submit_executor(task)

        assert result["status"] == "failed"
        assert "has no ports mapped" in result["error_msg"]

    @patch("executor_manager.executors.docker.executor.build_callback_url")
    @patch("executor_manager.executors.docker.executor.find_available_port")
    @patch("executor_manager.utils.executor_name.generate_executor_name")
    def test_submit_executor_docker_error(
        self,
        mock_name,
        mock_port,
        mock_callback,
        executor,
        sample_task,
        mock_subprocess,
    ):
        """Test submitting executor with Docker error"""
        mock_name.return_value = "new-executor"
        mock_port.return_value = 8080
        mock_callback.return_value = "http://callback.url"

        # Reset mock and simulate error
        mock_subprocess.run.reset_mock()
        mock_subprocess.run.side_effect = subprocess.CalledProcessError(
            1, "docker run", stderr="Docker error"
        )

        result = executor.submit_executor(sample_task)

        assert result["status"] == "failed"
        assert "Docker run error" in result["error_msg"]

    @patch("executor_manager.executors.docker.utils.subprocess.run")
    def test_delete_executor_success(self, mock_run, executor):
        """Test deleting executor successfully"""
        # Mock subprocess.run calls:
        # 1. check_container_ownership
        # 2. delete_container (shell command)
        mock_run.side_effect = [
            MagicMock(stdout="test-executor\n", returncode=0),  # ownership check
            MagicMock(returncode=0),  # delete command
        ]

        result = executor.delete_executor("test-executor")

        assert result["status"] == "success"

    @patch("executor_manager.executors.docker.utils.check_container_ownership")
    def test_delete_executor_unauthorized(self, mock_check, executor):
        """Test deleting executor without ownership"""
        mock_check.return_value = False

        result = executor.delete_executor("test-executor")

        assert result["status"] == "unauthorized"
        assert "not owned by" in result["error_msg"]

    @patch("executor_manager.executors.docker.utils.subprocess.run")
    def test_get_executor_count_success(self, mock_run, executor):
        """Test getting executor count successfully"""
        # Mock docker ps output with two running tasks
        mock_run.return_value = MagicMock(
            stdout="123|456|789|online|container1\n124|457|790|online|container2\n",
            returncode=0,
        )

        result = executor.get_executor_count()

        assert result["status"] == "success"
        assert result["running"] == 2
        assert "123" in result["task_ids"]
        assert "124" in result["task_ids"]

    @patch("executor_manager.executors.docker.utils.subprocess.run")
    def test_get_executor_count_with_label_selector(self, mock_run, executor):
        """Test getting executor count with label selector"""
        # Mock docker ps output with one running task
        mock_run.return_value = MagicMock(
            stdout="123|456|789|online|container1\n", returncode=0
        )

        result = executor.get_executor_count(label_selector="task_id=123")

        assert result["status"] == "success"
        assert result["running"] == 1
        assert "123" in result["task_ids"]

    @patch("executor_manager.executors.docker.utils.subprocess.run")
    def test_get_current_task_ids_success(self, mock_run, executor):
        """Test getting current task IDs successfully"""
        # Mock docker ps output
        mock_run.return_value = MagicMock(
            stdout="123|1|789|online|container1\n456|2|790|online|container2\n",
            returncode=0,
        )

        result = executor.get_current_task_ids()

        assert result["status"] == "success"
        assert "123" in result["task_ids"]
        assert "456" in result["task_ids"]
        assert len(result["containers"]) == 2

    def test_call_callback_success(self, executor):
        """Test calling callback successfully"""
        mock_callback = MagicMock()

        executor._call_callback(
            mock_callback,
            task_id=123,
            subtask_id=456,
            executor_name="test-executor",
            progress=50,
            status=TaskStatus.RUNNING.value,
        )

        mock_callback.assert_called_once_with(
            task_id=123,
            subtask_id=456,
            executor_name="test-executor",
            progress=50,
            status=TaskStatus.RUNNING.value,
            error_message=None,
            result=None,
        )

    def test_call_callback_none(self, executor):
        """Test calling callback when callback is None"""
        # Should not raise any exception
        executor._call_callback(
            None,
            task_id=123,
            subtask_id=456,
            executor_name="test-executor",
            progress=50,
            status=TaskStatus.RUNNING.value,
        )

    def test_call_callback_error(self, executor):
        """Test calling callback with error"""
        mock_callback = MagicMock()
        mock_callback.side_effect = Exception("Callback error")

        # Should not raise exception, just log it
        executor._call_callback(
            mock_callback,
            task_id=123,
            subtask_id=456,
            executor_name="test-executor",
            progress=50,
            status=TaskStatus.RUNNING.value,
        )
