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

    def test_workspace_mount_and_runtime_root_agree(
        self, executor, monkeypatch, tmp_path
    ):
        monkeypatch.setenv("EXECUTOR_WORKSPACE", str(tmp_path))
        command = []
        executor._add_workspace_mount(command)
        assert command == [
            "-v",
            f"{tmp_path}:/root/.wegent/workspace",
            "-e",
            "WORKSPACE_ROOT=/root/.wegent/workspace",
        ]
        assert list(tmp_path.iterdir()) == []

    def test_without_workspace_mount_uses_executor_home_default(
        self, executor, monkeypatch
    ):
        monkeypatch.delenv("EXECUTOR_WORKSPACE", raising=False)
        command = []
        executor._add_workspace_mount(command)
        assert command == []

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
    def executor(self, mock_subprocess, mock_requests, callback_repository):
        """Create DockerExecutor instance with mocked dependencies"""
        # Mock docker availability check
        mock_subprocess.run.return_value = MagicMock(returncode=0)
        return DockerExecutor(
            subprocess_module=mock_subprocess, requests_module=mock_requests
        )

    @pytest.fixture
    def callback_repository(self, mocker):
        return mocker.patch(
            "executor_manager.services.sandbox.repository.get_sandbox_repository"
        ).return_value

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

    @patch.object(docker_executor_module, "PORT_RANGE_MIN", 12000)
    @patch.object(docker_executor_module, "PORT_RANGE_MAX", 12100)
    @patch.object(docker_executor_module, "build_callback_url")
    def test_prepare_docker_command(self, mock_callback, executor, sample_task):
        """Test preparing Docker run command"""
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
        assert "EXECUTOR_MODE=docker" in cmd
        assert "PORT=10001" in cmd
        assert cmd[cmd.index("-p") + 1] == "12000-12100:10001"
        assert not any(
            isinstance(item, str) and item.startswith("TASK_INFO=") for item in cmd
        )

    @patch.object(docker_executor_module, "build_callback_url")
    def test_prepare_docker_command_includes_callback_token(
        self, mock_callback, executor
    ):
        """New and legacy callback credentials both reach the runtime."""
        mock_callback.return_value = "http://callback.url"
        task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_image": "test/executor:latest",
            "executor_callback_token": "callback-token",
        }
        task_info = executor._extract_task_info(task)

        cmd = executor._prepare_docker_command(
            task, task_info, "test-executor", "test/executor:latest"
        )

        assert "CALLBACK_URL=http://callback.url" in cmd
        assert "EXECUTOR_CALLBACK_TOKEN=callback-token" in cmd
        assert "EXECUTOR_CALLBACK_SCOPE=task" in cmd

    @patch.dict(os.environ, {"TASK_API_DOMAIN": "http://backend:8000"}, clear=False)
    @patch.object(docker_executor_module, "build_callback_url")
    def test_prepare_docker_command_adds_task_api_domain(
        self, mock_callback, executor, sample_task
    ):
        """Docker containers should expose the task API domain."""
        mock_callback.return_value = "http://callback.url"

        task_info = executor._extract_task_info(sample_task)
        cmd = executor._prepare_docker_command(
            sample_task, task_info, "test-executor", "test/executor:latest"
        )

        assert "TASK_API_DOMAIN=http://backend:8000" in cmd
        assert "WEGENT_BACKEND_URL=http://backend:8000" not in cmd

    @pytest.mark.parametrize("value", [None, "1", "0"])
    @patch.object(
        docker_executor_module, "build_callback_url", return_value="http://callback.url"
    )
    def test_prepare_docker_command_forwards_stdout_debug_flag(
        self, mock_callback, executor, sample_task, monkeypatch, value
    ):
        name = "WEGENT_DEBUG_CLAUDE_STDOUT"
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)

        cmd = executor._prepare_docker_command(
            sample_task,
            executor._extract_task_info(sample_task),
            "test-executor",
            "test/executor:latest",
        )

        matches = [arg for arg in cmd if arg.startswith(f"{name}=")]
        assert matches == ([] if value is None else [f"{name}={value}"])
        if matches:
            assert cmd[cmd.index(matches[0]) - 1] == "-e"

    @patch.dict(
        os.environ,
        {
            "GIT_TOKEN_AES_KEY": "12345678901234567890123456789012",
            "GIT_TOKEN_AES_IV": "1234567890123456",
        },
        clear=False,
    )
    @patch.object(docker_executor_module, "build_callback_url")
    def test_prepare_docker_command_passes_git_token_keys(
        self, mock_callback, executor, sample_task
    ):
        """The backend hands over the git token as stored, which is encrypted.

        Without these keys the executor finds a credential it cannot read, drops it,
        and git falls back to prompting for a username -- surfacing as "could not
        read Username for ..." with nothing pointing at the missing key.
        """
        mock_callback.return_value = "http://callback.url"

        task_info = executor._extract_task_info(sample_task)
        cmd = executor._prepare_docker_command(
            sample_task, task_info, "test-executor", "test/executor:latest"
        )

        assert "GIT_TOKEN_AES_KEY=12345678901234567890123456789012" in cmd
        assert "GIT_TOKEN_AES_IV=1234567890123456" in cmd

    @patch.dict(
        os.environ, {"GIT_TOKEN_AES_KEY": "", "GIT_TOKEN_AES_IV": ""}, clear=False
    )
    @patch.object(docker_executor_module, "build_callback_url")
    def test_prepare_docker_command_omits_empty_git_token_keys(
        self, mock_callback, executor, sample_task
    ):
        """An empty key would have the executor decrypt with a default, producing a
        wrong token that fails as an authentication error rather than as the
        configuration error it is."""
        mock_callback.return_value = "http://callback.url"

        task_info = executor._extract_task_info(sample_task)
        cmd = executor._prepare_docker_command(
            sample_task, task_info, "test-executor", "test/executor:latest"
        )

        assert not [arg for arg in cmd if arg.startswith("GIT_TOKEN_AES_")]

    @patch.object(docker_executor_module, "build_callback_url")
    def test_prepare_docker_command_sandbox_env_vars(self, mock_callback, executor):
        """Test sandbox command uses sandbox-specific env vars without TASK_INFO."""
        mock_callback.return_value = "http://callback.url"
        sandbox_task = {
            "task_id": 123,
            "subtask_id": 456,
            "user": {"name": "test_user"},
            "executor_image": "test/executor:latest",
            "type": "sandbox",
            "auth_token": "token-123",
            "skill_identity_token": "skill-jwt",
            "executor_callback_token": "callback-token",
        }

        task_info = executor._extract_task_info(sandbox_task)
        cmd = executor._prepare_docker_command(
            sandbox_task, task_info, "sandbox-executor", "test/executor:latest"
        )

        assert "AUTH_TOKEN=token-123" in cmd
        assert "EXECUTOR_CALLBACK_SCOPE=sandbox" in cmd
        assert "TASK_ID=123" in cmd
        assert "EXECUTOR_MODE=docker" in cmd
        assert "WEGENT_SKILL_USER_NAME=test_user" in cmd
        assert "WEGENT_SKILL_IDENTITY_TOKEN=skill-jwt" in cmd
        assert not any(
            isinstance(item, str) and item.startswith("TASK_INFO=") for item in cmd
        )

    def test_add_workspace_mount_creates_missing_host_directory(
        self, executor, tmp_path, monkeypatch
    ):
        """Docker bind mounts must point at an existing host directory."""
        workspace = tmp_path / "executor-workspace"
        monkeypatch.setenv("EXECUTOR_WORKSPACE", str(workspace))
        cmd = []

        executor._add_workspace_mount(cmd)

        assert workspace.is_dir()
        assert cmd == [
            "-v",
            f"{workspace}:/root/.wegent/workspace",
            "-e",
            "WORKSPACE_ROOT=/root/.wegent/workspace",
        ]

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
        assert task["executor_name"] == "existing-executor"
        assert task["executor_namespace"] == ""
        mock_wait_ready.assert_called_once_with("existing-executor")
        mock_dispatch.assert_called_once_with(task, "existing-executor", {"port": 8080})
        mock_register.assert_called_once()

    def test_submit_executor_injects_generated_executor_name_into_openai_metadata(
        self, executor
    ):
        """Generated executor names should reach the container callback payload."""
        task = {
            "model": "claude-code",
            "input": "hello",
            "metadata": {
                "task_id": 123,
                "subtask_id": 456,
                "user": {"name": "test_user"},
                "type": "online",
            },
        }

        with (
            patch.object(
                docker_executor_module,
                "generate_executor_name",
                return_value="generated-executor",
            ),
            patch.object(executor, "_create_new_container") as mock_create,
        ):
            result = executor.submit_executor(task)

        assert result["status"] == "success"
        assert result["executor_name"] == "generated-executor"
        assert result["executor_namespace"] == ""
        assert task["metadata"]["executor_name"] == "generated-executor"
        assert task["metadata"]["executor_namespace"] == ""
        mock_create.assert_called_once()

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

    @pytest.mark.parametrize("task_type", ["online", "validation"])
    @pytest.mark.parametrize(
        "base_image", [None, "127.0.0.1:1/wegent/recovery-missing"]
    )
    @patch("executor_manager.executors.docker.executor.build_callback_url")
    @patch.object(docker_executor_module, "generate_executor_name")
    def test_submit_executor_docker_error_keeps_credentials_private(
        self,
        mock_name,
        mock_callback,
        executor,
        sample_task,
        mock_subprocess,
        task_type,
        mocker,
        base_image,
    ):
        """Test submitting executor with Docker error"""
        mock_name.return_value = "new-executor"
        mock_callback.return_value = "http://callback.url"
        sample_task["type"] = task_type
        credential = "test-only-callback-secret"
        logger = mocker.patch.object(docker_executor_module, "logger")
        validation = mocker.patch.object(executor, "_report_validation_stage")
        mocker.patch.object(executor, "_should_enable_seccomp", return_value=True)
        mocker.patch.object(
            executor, "_get_base_image_from_task", return_value=base_image
        )
        mocker.patch.object(executor, "_ensure_executor_binary_updated")

        with patch.object(
            docker_executor_module,
            "generate_callback_token",
            return_value=credential,
        ):
            # Reset mock and simulate error
            mock_subprocess.run.reset_mock()
            mock_subprocess.run.side_effect = subprocess.CalledProcessError(
                1,
                ["docker", "run", "-e", f"EXECUTOR_CALLBACK_TOKEN={credential}"],
                stderr=f"Docker failed to pull image: {credential}",
            )

            result = executor.submit_executor(sample_task)

        assert result["status"] == "failed"
        image = base_image or sample_task["executor_image"]
        assert f"exited with status 1 (image {image})" in result["error_msg"]
        assert credential not in result["error_msg"]
        assert credential not in str(logger.mock_calls)
        if task_type == "validation":
            assert validation.call_args.kwargs["stage"] == "pulling_image"
            assert credential not in validation.call_args.kwargs["message"]
            assert credential not in validation.call_args.kwargs["error_message"]

    @patch.object(docker_executor_module, "get_running_task_details")
    def test_cancel_task_uses_running_container_when_task_ids_is_empty(
        self, mock_running_tasks, executor, mock_requests
    ):
        """Solo tasks remain cancellable when subtask_next_id is empty."""
        mock_running_tasks.return_value = {
            "status": "success",
            "task_ids": [],
            "containers": [
                {
                    "task_id": "6258",
                    "subtask_id": "8664",
                    "container_name": "wegent-task-admin-test",
                    "subtask_next_id": "",
                    "task_type": "online",
                }
            ],
        }
        mock_requests.post.return_value = MagicMock()

        with patch.object(executor, "_get_container_port", return_value=(10005, None)):
            result = executor.cancel_task(6258, 8664)

        assert result["status"] == "success"
        mock_requests.post.assert_called_once_with(
            f"http://{docker_executor_module.DEFAULT_DOCKER_HOST}:10005"
            "/api/tasks/cancel?task_id=6258&subtask_id=8664",
            timeout=10,
        )

    def test_create_new_container_dispatches_initial_task_for_regular_tasks(
        self, executor, sample_task, mock_subprocess
    ):
        """Test new regular container dispatches the first request after startup."""
        status = {"executor_name": "new-executor"}
        task_info = executor._extract_task_info(sample_task)

        with (
            patch.object(
                docker_executor_module,
                "generate_callback_token",
                return_value="callback-token",
            ),
            patch(
                "executor_manager.services.sandbox.repository.get_sandbox_repository",
                return_value=MagicMock(
                    load_executor_callback_token=lambda *args, **kwargs: "callback-token"
                ),
            ),
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
            assert "executor_callback_token" not in sample_task
            mock_dispatch.assert_called_once_with(sample_task, "new-executor", 8080)

    @pytest.mark.parametrize("task_type", ["online", "sandbox"])
    @pytest.mark.parametrize("nested_metadata", [False, True])
    def test_create_new_container_prepares_callback_token_before_creation(
        self, executor, sample_task, task_type, nested_metadata
    ):
        """The callback credential must be ready before the container command."""
        sample_task["type"] = task_type
        if nested_metadata:
            sample_task = {"metadata": sample_task}
        status = {"executor_name": "new-executor"}
        task_info = executor._extract_task_info(sample_task)

        with (
            patch.object(
                docker_executor_module,
                "generate_callback_token",
                return_value="callback-token",
            ) as mock_prepare,
            patch.object(executor, "create_instance") as mock_create,
            patch.object(executor, "wait_instance_ready", return_value={"port": 8080}),
            patch.object(executor, "dispatch_task_to_instance") as mock_dispatch,
        ):
            executor._create_new_container(sample_task, task_info, status)

        mock_prepare.assert_called_once_with()
        created_task = mock_create.call_args.args[0]
        startup_fields = created_task["metadata"] if nested_metadata else created_task
        request_fields = sample_task["metadata"] if nested_metadata else sample_task
        assert startup_fields["executor_callback_token"] == "callback-token"
        assert "executor_callback_token" not in request_fields
        assert mock_create.call_count == 1
        assert mock_dispatch.call_count == (0 if task_type == "sandbox" else 1)

    @pytest.mark.parametrize("delete_status", ["success", "failed"])
    def test_sandbox_task_cleanup_preserves_the_regular_executor(
        self, executor, mocker, delete_status
    ):
        inventory = mocker.patch.object(
            docker_executor_module,
            "get_running_task_details",
            return_value={
                "status": "success",
                "containers": [
                    {"container_name": "regular", "task_type": "online"},
                    {"container_name": "sandbox", "task_type": "sandbox"},
                ],
            },
        )
        delete = mocker.patch.object(
            docker_executor_module,
            "delete_container",
            return_value={"status": delete_status},
        )
        repository = mocker.patch(
            "executor_manager.services.sandbox.repository.get_sandbox_repository"
        ).return_value

        result = executor.delete_executor_by_task_id("123", sandbox_only=True)

        inventory.assert_called_once_with(
            label_selector="task_id=123", include_stopped=True
        )
        delete.assert_called_once_with("sandbox")
        assert result["status"] == delete_status
        if delete_status == "success":
            assert result["deleted_containers"] == ["sandbox"]
            repository.delete_executor_binding.assert_called_once_with(
                123, expected_executor_name="sandbox", sandbox=True
            )
        else:
            assert result["deleted_containers"] == []
            repository.delete_executor_binding.assert_not_called()

    def test_validation_reports_callback_publication_failure(
        self, executor, sample_task, mocker, callback_repository, mock_subprocess
    ):
        sample_task["type"] = "validation"
        callback_repository.save_executor_binding.return_value = False
        mock_subprocess.run.return_value.stdout = "new-container-id"
        delete = mocker.patch.object(docker_executor_module, "delete_container")
        validation = mocker.patch.object(executor, "_report_validation_stage")

        result = executor.submit_executor(sample_task)

        assert result["status"] == "failed"
        delete.assert_called_once_with("new-container-id")
        assert validation.call_args.kwargs["status"] == "failed"
        assert validation.call_args.kwargs["valid"] is False

    def test_recreated_container_rotates_callback_token_after_docker_succeeds(
        self, executor, sample_task, mock_subprocess, callback_repository
    ):
        """The first runtime receives the callback credential at startup."""
        status = {"executor_name": "new-executor"}
        task_info = executor._extract_task_info(sample_task)

        with (
            patch.object(docker_executor_module, "build_callback_url") as mock_callback,
            patch.object(
                docker_executor_module,
                "generate_callback_token",
                side_effect=["callback-token", "unused-token", "replacement-token"],
            ),
            patch.object(executor, "_wait_for_container_ready", return_value=8080),
            patch.object(executor, "dispatch_task_to_instance"),
        ):
            mock_callback.return_value = "http://callback.url"
            mock_subprocess.run.reset_mock()
            mock_subprocess.run.return_value = MagicMock(
                stdout="container-id\n", returncode=0
            )

            executor._create_new_container(sample_task, task_info, status)

            command = mock_subprocess.run.call_args.args[0]
            assert "EXECUTOR_CALLBACK_TOKEN=callback-token" in command
            mock_subprocess.run.side_effect = subprocess.CalledProcessError(1, command)
            with pytest.raises(RuntimeError, match="exited with status 1"):
                executor._create_new_container(sample_task, task_info, status)
            callback_repository.save_executor_binding.assert_called_once()

            mock_subprocess.run.side_effect = None
            mock_subprocess.run.return_value.stdout = "replacement-container-id"
            executor._create_new_container(sample_task, task_info, status)

        assert callback_repository.save_executor_binding.call_args_list == [
            call(123, "new-executor", sandbox=False, callback_token="callback-token"),
            call(
                123, "new-executor", sandbox=False, callback_token="replacement-token"
            ),
        ]

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
                docker_executor_module,
                "generate_callback_token",
                return_value="callback-token",
            ),
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
            patch.object(
                docker_executor_module,
                "generate_callback_token",
                return_value="callback-token",
            ),
            patch.object(executor, "create_instance") as mock_create,
            patch.object(executor, "wait_instance_ready") as mock_wait_ready,
            patch.object(
                executor, "dispatch_task_to_instance"
            ) as mock_dispatch_task_to_instance,
        ):
            executor._create_new_container(prepare_task, task_info, status)

        assert "executor_callback_token" not in prepare_task
        mock_create.assert_called_once_with(
            {**prepare_task, "executor_callback_token": "callback-token"},
            task_info,
            "prepare-executor",
        )
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
            patch.object(
                docker_executor_module,
                "generate_callback_token",
                return_value="callback-token",
            ),
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

    @pytest.mark.parametrize(
        ("runtime_status", "expected"),
        [
            ("running", "unauthorized"),
            ("error", "unauthorized"),
            ("not_found", "not_found"),
        ],
    )
    def test_delete_executor_without_confirmed_ownership(
        self, executor, mocker, runtime_status, expected
    ):
        mocker.patch.object(
            docker_executor_module, "check_container_ownership", return_value=False
        )
        mocker.patch.object(
            executor, "get_container_status", return_value={"status": runtime_status}
        )
        delete = mocker.patch.object(docker_executor_module, "delete_container")

        result = executor.delete_executor("test-executor")

        assert result["status"] == expected
        delete.assert_not_called()

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

    @patch.object(docker_executor_module, "get_running_task_details")
    def test_cancel_task_uses_container_details_when_task_ids_empty(
        self, mock_get_running_task_details, executor
    ):
        """Cancel should use matching container details even when task_ids is empty."""
        mock_get_running_task_details.return_value = {
            "status": "success",
            "task_ids": [],
            "containers": [
                {
                    "task_id": "6296",
                    "subtask_id": "8754",
                    "container_name": "wegent-task-admin-fe182dcc899e086",
                    "subtask_next_id": "",
                    "task_type": "online",
                }
            ],
        }
        executor.requests.post.return_value = MagicMock(
            raise_for_status=MagicMock(),
        )

        with patch.object(executor, "_get_container_port", return_value=(10000, None)):
            result = executor.cancel_task(6296)

        assert result["status"] == "success"
        executor.requests.post.assert_called_once_with(
            f"http://{docker_executor_module.DEFAULT_DOCKER_HOST}:10000/api/tasks/cancel?task_id=6296",
            timeout=10,
        )

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
