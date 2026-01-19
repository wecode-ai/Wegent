# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import subprocess
from unittest.mock import MagicMock, Mock, call, patch

import pytest
from shared.status import TaskStatus

from executor_manager.executors.docker.executor import DockerExecutor


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

    @patch("executor_manager.executors.docker.executor.find_available_port")
    @patch("executor_manager.executors.docker.executor.build_callback_url")
    def test_prepare_docker_command(
        self, mock_callback, mock_find_port, executor, sample_task
    ):
        """Test preparing Docker run command"""
        # Mock find_available_port to avoid actual Docker command execution
        mock_find_port.return_value = 8080
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

    @patch("executor_manager.executors.docker.executor.get_container_ports")
    def test_submit_executor_existing_container_no_ports(self, mock_ports, executor):
        """Test submitting executor to existing container with no ports"""
        task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_name": "existing-executor",
        }

        mock_ports.return_value = {"status": "success", "ports": []}

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

    @patch.dict("os.environ", {}, clear=True)
    @patch("executor_manager.config.config.EXECUTOR_NETWORK_MODE", "")
    def test_add_network_config_default(self, executor):
        """Test network config with default settings (no env vars set)"""
        cmd = []
        network_mode = executor._add_network_config(cmd)

        # Should not add --network flag for default
        assert "--network" not in cmd
        assert network_mode == "bridge"

    @patch.dict("os.environ", {"EXECUTOR_NETWORK_MODE": "host"}, clear=True)
    @patch("executor_manager.config.config.EXECUTOR_NETWORK_MODE", "host")
    def test_add_network_config_host_mode(self, executor):
        """Test network config with EXECUTOR_NETWORK_MODE=host"""
        cmd = []
        network_mode = executor._add_network_config(cmd)

        assert "--network" in cmd
        assert "host" in cmd
        assert network_mode == "host"

    @patch.dict("os.environ", {"EXECUTOR_NETWORK_MODE": "bridge"}, clear=True)
    @patch("executor_manager.config.config.EXECUTOR_NETWORK_MODE", "bridge")
    def test_add_network_config_bridge_mode(self, executor):
        """Test network config with EXECUTOR_NETWORK_MODE=bridge"""
        cmd = []
        network_mode = executor._add_network_config(cmd)

        assert "--network" in cmd
        assert "bridge" in cmd
        assert network_mode == "bridge"

    @patch.dict("os.environ", {"NETWORK": "my-network"}, clear=True)
    @patch("executor_manager.config.config.EXECUTOR_NETWORK_MODE", "")
    def test_add_network_config_legacy_network(self, executor):
        """Test network config with legacy NETWORK env var"""
        cmd = []
        network_mode = executor._add_network_config(cmd)

        assert "--network" in cmd
        assert "my-network" in cmd
        assert network_mode == "my-network"

    @patch.dict(
        "os.environ",
        {"EXECUTOR_NETWORK_MODE": "host", "NETWORK": "my-network"},
        clear=True,
    )
    @patch("executor_manager.config.config.EXECUTOR_NETWORK_MODE", "host")
    def test_add_network_config_priority(self, executor):
        """Test that EXECUTOR_NETWORK_MODE has priority over NETWORK"""
        cmd = []
        network_mode = executor._add_network_config(cmd)

        # Should use EXECUTOR_NETWORK_MODE, not NETWORK
        assert "--network" in cmd
        assert "host" in cmd
        assert "my-network" not in cmd
        assert network_mode == "host"

    def test_get_container_host_host_mode(self, executor, mock_subprocess):
        """Test _get_container_host returns localhost for host network mode"""
        mock_subprocess.run.return_value = MagicMock(
            stdout="host\n", returncode=0, stderr=""
        )

        host = executor._get_container_host("test-container")

        assert host == "localhost"
        mock_subprocess.run.assert_called_with(
            [
                "docker",
                "inspect",
                "--format",
                "{{.HostConfig.NetworkMode}}",
                "test-container",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )

    def test_get_container_host_bridge_mode(self, executor, mock_subprocess):
        """Test _get_container_host returns DEFAULT_DOCKER_HOST for bridge mode"""
        mock_subprocess.run.return_value = MagicMock(
            stdout="bridge\n", returncode=0, stderr=""
        )

        host = executor._get_container_host("test-container")

        assert host == "host.docker.internal"

    def test_get_container_host_custom_network(self, executor, mock_subprocess):
        """Test _get_container_host returns DEFAULT_DOCKER_HOST for custom network"""
        mock_subprocess.run.return_value = MagicMock(
            stdout="my-custom-network\n", returncode=0, stderr=""
        )

        host = executor._get_container_host("test-container")

        assert host == "host.docker.internal"

    def test_get_container_host_error(self, executor, mock_subprocess):
        """Test _get_container_host returns DEFAULT_DOCKER_HOST on error"""
        mock_subprocess.run.side_effect = Exception("Docker error")

        host = executor._get_container_host("test-container")

        # Should return default host on error
        assert host == "host.docker.internal"

    @patch("executor_manager.executors.docker.utils.get_docker_used_ports")
    @patch("executor_manager.executors.docker.executor.build_callback_url")
    @patch("executor_manager.executors.docker.executor.find_available_port")
    @patch.dict("os.environ", {"EXECUTOR_NETWORK_MODE": "host"}, clear=True)
    @patch("executor_manager.config.config.EXECUTOR_NETWORK_MODE", "host")
    def test_prepare_docker_command_host_mode_no_port_mapping(
        self, mock_port, mock_callback, mock_docker_ports, executor, sample_task
    ):
        """Test that host network mode does not add port mapping"""
        mock_port.return_value = 8080
        mock_callback.return_value = "http://callback.url"
        mock_docker_ports.return_value = set()  # Mock to avoid actual docker calls

        task_info = executor._extract_task_info(sample_task)
        executor_name = "test-executor"
        executor_image = "test/executor:latest"

        cmd = executor._prepare_docker_command(
            sample_task, task_info, executor_name, executor_image
        )

        # Should have --network host
        assert "--network" in cmd
        host_idx = cmd.index("--network")
        assert cmd[host_idx + 1] == "host"

        # Should NOT have -p flag (port mapping)
        assert "-p" not in cmd

        # Should still have PORT env var
        assert any("PORT=8080" in str(item) for item in cmd)

    @patch("executor_manager.executors.docker.utils.get_docker_used_ports")
    @patch("executor_manager.executors.docker.executor.build_callback_url")
    @patch("executor_manager.executors.docker.executor.find_available_port")
    @patch.dict("os.environ", {}, clear=True)
    @patch("executor_manager.config.config.EXECUTOR_NETWORK_MODE", "")
    def test_prepare_docker_command_bridge_mode_with_port_mapping(
        self, mock_port, mock_callback, mock_docker_ports, executor, sample_task
    ):
        """Test that bridge network mode adds port mapping"""
        mock_port.return_value = 8080
        mock_callback.return_value = "http://callback.url"
        mock_docker_ports.return_value = set()  # Mock to avoid actual docker calls

        task_info = executor._extract_task_info(sample_task)
        executor_name = "test-executor"
        executor_image = "test/executor:latest"

        cmd = executor._prepare_docker_command(
            sample_task, task_info, executor_name, executor_image
        )

        # Should have -p flag (port mapping)
        assert "-p" in cmd
        p_idx = cmd.index("-p")
        assert cmd[p_idx + 1] == "8080:8080"

        # Should have PORT env var
        assert any("PORT=8080" in str(item) for item in cmd)
