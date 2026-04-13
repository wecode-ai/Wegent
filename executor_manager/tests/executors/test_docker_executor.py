# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
import subprocess
from unittest.mock import MagicMock, Mock, call, patch

import pytest
import requests

from executor_manager.executors.docker import executor as docker_executor_module
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

    @patch.dict(os.environ, {"EXECUTOR_IMAGE": ""}, clear=False)
    def test_get_executor_image_missing(self, executor):
        """Test getting executor image when missing"""
        task = {}
        with pytest.raises(ValueError, match="Executor image not provided"):
            executor._get_executor_image(task)

    @patch.object(docker_executor_module, "find_available_port")
    @patch.object(docker_executor_module, "build_callback_url")
    def test_prepare_docker_command(
        self, mock_callback, mock_find_port, executor, sample_task
    ):
        """Test preparing Docker run command"""
        mock_find_port.return_value = 8080
        mock_callback.return_value = "http://callback.url"
        sample_task["skill_identity_token"] = "skill-jwt"

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
        assert "WEGENT_SKILL_USER_NAME=test_user" in cmd
        assert "WEGENT_SKILL_IDENTITY_TOKEN=skill-jwt" in cmd
        assert not any(
            isinstance(item, str) and item.startswith("TASK_INFO=") for item in cmd
        )

    @patch.object(docker_executor_module, "find_available_port")
    @patch.object(docker_executor_module, "build_callback_url")
    def test_prepare_docker_command_sandbox_env_vars(
        self, mock_callback, mock_find_port, executor
    ):
        """Test sandbox command uses sandbox-specific env vars without TASK_INFO."""
        mock_find_port.return_value = 8080
        mock_callback.return_value = "http://callback.url"
        sandbox_task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_image": "test/executor:latest",
            "type": "sandbox",
            "auth_token": "token-123",
            "skill_identity_token": "skill-jwt",
        }

        task_info = executor._extract_task_info(sandbox_task)
        cmd = executor._prepare_docker_command(
            sandbox_task, task_info, "sandbox-executor", "test/executor:latest"
        )

        assert "AUTH_TOKEN=token-123" in cmd
        assert "TASK_ID=123" in cmd
        assert "WEGENT_SKILL_USER_NAME=test_user" in cmd
        assert "WEGENT_SKILL_IDENTITY_TOKEN=skill-jwt" in cmd
        assert not any(
            isinstance(item, str) and item.startswith("TASK_INFO=") for item in cmd
        )

    def test_submit_executor_existing_container_success(self, executor):
        """Test submitting executor to existing container successfully"""
        task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_name": "existing-executor",
        }

        with (
            patch.object(
                executor,
                "get_container_status",
                return_value={"exists": True, "status": "running"},
            ),
            patch.object(
                executor, "wait_instance_ready", return_value={"port": 8080}
            ) as mock_wait_ready,
            patch.object(
                executor,
                "dispatch_task_to_instance",
                return_value={"status": "success", "error_msg": ""},
            ) as mock_dispatch,
            patch.object(executor, "register_task_for_heartbeat") as mock_register,
        ):
            result = executor.submit_executor(task)

        assert result["status"] == "success"
        assert result["executor_name"] == "existing-executor"
        mock_wait_ready.assert_called_once_with("existing-executor")
        mock_dispatch.assert_called_once_with(task, "existing-executor", {"port": 8080})
        mock_register.assert_called_once()

    def test_submit_executor_existing_container_no_ports(self, executor):
        """Test submitting executor to existing container with no ports"""
        task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_name": "existing-executor",
        }

        with (
            patch.object(
                executor,
                "get_container_status",
                return_value={"exists": True, "status": "running"},
            ),
            patch.object(
                executor,
                "wait_instance_ready",
                side_effect=RuntimeError(
                    "Container existing-executor exists but has no ports mapped"
                ),
            ),
        ):
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

    def test_create_new_container_dispatches_initial_task_for_regular_tasks(
        self, executor, sample_task, mock_subprocess
    ):
        """Test new regular container dispatches the first request after startup."""
        status = {"executor_name": "new-executor"}
        task_info = executor._extract_task_info(sample_task)

        with (
            patch.object(
                executor,
                "_prepare_docker_command",
                return_value=["docker", "run", "dummy"],
            ),
            patch.object(
                executor, "_dispatch_initial_task_to_new_container"
            ) as mock_dispatch,
            patch.object(
                executor, "_wait_for_container_ready", return_value=8080
            ) as mock_wait_ready,
            patch.object(executor, "register_task_for_heartbeat"),
        ):
            mock_subprocess.run.reset_mock()
            mock_subprocess.run.return_value = MagicMock(
                stdout="container-id\n", returncode=0
            )

            executor._create_new_container(sample_task, task_info, status)

            mock_wait_ready.assert_called_once_with("new-executor")
            mock_dispatch.assert_called_once_with(sample_task, "new-executor", 8080)

    def test_create_new_container_does_not_dispatch_for_sandbox(
        self, executor, mock_subprocess
    ):
        """Test sandbox container startup does not auto-dispatch first task."""
        sandbox_task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_image": "test/executor:latest",
            "type": "sandbox",
        }
        status = {"executor_name": "sandbox-executor"}
        task_info = executor._extract_task_info(sandbox_task)

        with (
            patch.object(
                executor,
                "_prepare_docker_command",
                return_value=["docker", "run", "dummy"],
            ),
            patch.object(
                executor, "_dispatch_initial_task_to_new_container"
            ) as mock_dispatch,
            patch.object(executor, "_wait_for_container_ready") as mock_wait_ready,
            patch.object(executor, "register_task_for_heartbeat"),
        ):
            mock_subprocess.run.reset_mock()
            mock_subprocess.run.return_value = MagicMock(
                stdout="container-id\n", returncode=0
            )

            executor._create_new_container(sandbox_task, task_info, status)

            mock_wait_ready.assert_not_called()
            mock_dispatch.assert_not_called()

    def test_create_new_container_prepare_only_skips_initial_dispatch(self, executor):
        """Prepare-only regular tasks should create the container without dispatching."""
        prepare_task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_image": "test/executor:latest",
            "type": "online",
            "prepare_only": True,
        }
        status = {"executor_name": "prepare-executor"}
        task_info = executor._extract_task_info(prepare_task)

        with (
            patch.object(executor, "create_instance") as mock_create,
            patch.object(executor, "wait_instance_ready") as mock_wait_ready,
            patch.object(
                executor, "dispatch_task_to_instance"
            ) as mock_dispatch_task_to_instance,
        ):
            executor._create_new_container(prepare_task, task_info, status)

        mock_create.assert_called_once_with(prepare_task, task_info, "prepare-executor")
        mock_wait_ready.assert_called_once_with("prepare-executor")
        mock_dispatch_task_to_instance.assert_not_called()

    @patch.dict(
        os.environ,
        {
            "VALIDATION_KEEP_FAILED_CONTAINER": "true",
        },
        clear=False,
    )
    @patch("executor_manager.executors.docker.executor.delete_container")
    def test_create_new_container_keeps_validation_container_on_dispatch_failure(
        self, mock_delete_container, executor
    ):
        """Validation containers should be kept on startup failure when debug flag is enabled."""
        validation_task = {
            "task_id": 123,
            "subtask_id": 1,
            "user": {"name": "validator"},
            "executor_image": "test/executor:latest",
            "type": "validation",
            "bot": [{"base_image": "test/base:latest"}],
        }
        status = {"executor_name": "validation-executor"}
        task_info = executor._extract_task_info(validation_task)

        with (
            patch.object(executor, "create_instance"),
            patch.object(
                executor,
                "wait_instance_ready",
                side_effect=RuntimeError("container not ready"),
            ),
        ):
            with pytest.raises(RuntimeError, match="container not ready"):
                executor._create_new_container(validation_task, task_info, status)

        mock_delete_container.assert_not_called()

    @patch.dict(
        os.environ,
        {
            "VALIDATION_KEEP_FAILED_CONTAINER": "true",
        },
        clear=False,
    )
    def test_check_container_health_keeps_failed_validation_container_when_enabled(
        self, executor, mock_subprocess
    ):
        """Validation health check should not remove exited container when debug flag is enabled."""
        task = {
            "task_id": 123,
            "subtask_id": 1,
            "type": "validation",
            "validation_params": {"validation_id": "vid-1"},
        }

        mock_subprocess.run.side_effect = [
            MagicMock(returncode=0, stdout="exited\n"),  # container status
            MagicMock(returncode=0, stdout="executor crashed\n"),  # logs
            MagicMock(returncode=0, stdout="1\n"),  # exit code
        ]

        with (
            patch("executor_manager.executors.docker.executor.time.sleep"),
            patch.object(
                executor,
                "_report_validation_stage",
            ),
        ):
            with pytest.raises(RuntimeError, match="Container exited immediately"):
                executor._check_container_health(
                    task, "validation-executor", is_validation_task=True
                )

        rm_calls = [
            call_args
            for call_args in mock_subprocess.run.call_args_list
            if call_args[0][0][:3] == ["docker", "rm", "-f"]
        ]
        assert len(rm_calls) == 0

    @patch.dict(
        os.environ,
        {
            "EXECUTOR_READY_MAX_RETRIES": "2",
            "EXECUTOR_READY_INTERVAL": "0",
            "EXECUTOR_READY_SUCCESS_THRESHOLD": "1",
        },
        clear=False,
    )
    def test_wait_for_container_ready_success(self, executor):
        """Test wait_ready returns port when container is healthy."""
        with (
            patch.object(
                executor,
                "get_container_status",
                return_value={"exists": True, "status": "running"},
            ),
            patch.object(executor, "_get_container_port", return_value=(8081, None)),
            patch.object(executor, "_is_container_http_ready", return_value=True),
        ):
            port = executor._wait_for_container_ready("ready-container")

        assert port == 8081

    @patch.dict(
        os.environ,
        {
            "EXECUTOR_READY_MAX_RETRIES": "2",
            "EXECUTOR_READY_INTERVAL": "0",
            "EXECUTOR_READY_SUCCESS_THRESHOLD": "1",
        },
        clear=False,
    )
    def test_wait_for_container_ready_timeout(self, executor):
        """Test wait_ready raises timeout error when container never becomes ready."""
        with (
            patch.object(
                executor,
                "get_container_status",
                return_value={"exists": True, "status": "running"},
            ),
            patch.object(
                executor,
                "_get_container_port",
                return_value=(None, "container port not available"),
            ),
        ):
            with pytest.raises(RuntimeError, match="failed to become ready"):
                executor._wait_for_container_ready("not-ready-container")

    @patch.dict(
        os.environ,
        {
            "EXECUTOR_INITIAL_DISPATCH_MAX_RETRIES": "2",
            "EXECUTOR_INITIAL_DISPATCH_RETRY_INTERVAL": "0",
            "EXECUTOR_INITIAL_DISPATCH_TIMEOUT": "1",
        },
        clear=False,
    )
    def test_dispatch_initial_task_retries_then_succeeds(self, executor, sample_task):
        """Test initial dispatch retries on transient request errors."""
        success_response = MagicMock()
        success_response.status_code = 200

        with patch.object(
            executor,
            "_send_task_to_container",
            side_effect=[requests.RequestException("temporary"), success_response],
        ) as mock_send:
            executor._dispatch_initial_task_to_new_container(
                sample_task, "new-executor", 8080
            )

        assert mock_send.call_count == 2

    @patch.dict(
        os.environ,
        {
            "VALIDATION_INITIAL_DISPATCH_TIMEOUT": "60",
            "VALIDATION_INITIAL_DISPATCH_MAX_RETRIES": "1",
            "VALIDATION_INITIAL_DISPATCH_RETRY_INTERVAL": "0",
        },
        clear=False,
    )
    def test_dispatch_initial_task_uses_validation_specific_limits(self, executor):
        """Validation initial dispatch should use dedicated timeout/retry settings."""
        validation_task = {
            "task_id": 123,
            "subtask_id": 1,
            "type": "validation",
        }
        success_response = MagicMock()
        success_response.status_code = 200

        with patch.object(
            executor, "_send_task_to_container", return_value=success_response
        ) as mock_send:
            executor._dispatch_initial_task_to_new_container(
                validation_task, "validation-executor", 8080
            )

        mock_send.assert_called_once_with(
            validation_task, "host.docker.internal", 8080, timeout=60.0
        )

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
