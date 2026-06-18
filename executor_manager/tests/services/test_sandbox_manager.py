# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for SandboxManager service."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest


class TestSandboxManager:
    """Test cases for SandboxManager class."""

    @pytest.fixture(autouse=True)
    def reset_singletons(self):
        """Reset singleton instances before each test."""
        from executor_manager.common.redis_factory import RedisClientFactory
        from executor_manager.common.singleton import SingletonMeta
        from executor_manager.services.heartbeat_manager import HeartbeatManager

        # Reset SingletonMeta instances
        SingletonMeta.reset_all_instances()
        RedisClientFactory.reset()
        HeartbeatManager._instance = None
        yield
        SingletonMeta.reset_all_instances()
        RedisClientFactory.reset()
        HeartbeatManager._instance = None
        # Reset global instances
        import executor_manager.services.heartbeat_manager as hm_module

        hm_module._heartbeat_manager = None

    @pytest.fixture
    def sandbox_manager_with_mock_redis(self, mocker, mock_redis_client):
        """Create SandboxManager with mocked Redis."""
        mocker.patch(
            "executor_manager.common.redis_factory.RedisClientFactory.get_sync_client",
            return_value=mock_redis_client,
        )
        mocker.patch("redis.from_url", return_value=mock_redis_client)
        from executor_manager.services.sandbox import SandboxManager

        return SandboxManager()

    @pytest.fixture
    def sample_sandbox_redis_data(self, sample_sandbox_metadata):
        """Sample sandbox data as stored in Redis."""
        return json.dumps(
            {
                "sandbox_id": "12345",
                "container_name": "wegent-task-testuser-12345",
                "base_url": "http://localhost:10001",
                "status": "running",
                "created_at": 1704067200.0,
                "started_at": 1704067210.0,
                "shell_type": "ClaudeCode",
                "user_id": 100,
                "user_name": "testuser",
                "metadata": sample_sandbox_metadata,
            }
        )

    # ----- Singleton Tests -----

    def test_get_instance_returns_singleton(self, mocker, mock_redis_client):
        """Test singleton pattern returns same instance."""
        # Mock before any import or instantiation
        mocker.patch(
            "executor_manager.common.redis_factory.redis.from_url",
            return_value=mock_redis_client,
        )
        mocker.patch(
            "executor_manager.services.sandbox.repository.RedisClientFactory.get_sync_client",
            return_value=mock_redis_client,
        )
        from executor_manager.services.sandbox import SandboxManager

        instance1 = SandboxManager()
        instance2 = SandboxManager()

        assert instance1 is instance2

    def test_get_sandbox_manager_global_function(self, mocker, mock_redis_client):
        """Test global get_sandbox_manager function."""
        mocker.patch(
            "executor_manager.common.redis_factory.redis.from_url",
            return_value=mock_redis_client,
        )
        mocker.patch(
            "executor_manager.services.sandbox.repository.RedisClientFactory.get_sync_client",
            return_value=mock_redis_client,
        )
        from executor_manager.services.sandbox import get_sandbox_manager

        manager1 = get_sandbox_manager()
        manager2 = get_sandbox_manager()

        assert manager1 is manager2

    # ----- Initialization Tests -----

    def test_init_redis_connection_success(self, mocker, mock_redis_client):
        """Test successful Redis connection during init."""
        mocker.patch(
            "executor_manager.common.redis_factory.redis.from_url",
            return_value=mock_redis_client,
        )
        mocker.patch(
            "executor_manager.services.sandbox.repository.RedisClientFactory.get_sync_client",
            return_value=mock_redis_client,
        )
        from executor_manager.services.sandbox import SandboxManager

        manager = SandboxManager()

        assert manager._repository is not None

    def test_init_redis_connection_failure(self, mocker):
        """Test handling Redis connection failure."""
        mocker.patch(
            "executor_manager.common.redis_factory.redis.from_url",
            side_effect=Exception("Connection refused"),
        )
        mocker.patch(
            "executor_manager.services.sandbox.repository.RedisClientFactory.get_sync_client",
            return_value=None,
        )
        from executor_manager.services.sandbox import SandboxManager

        manager = SandboxManager()

        # Repository is always initialized, but Redis client may be None
        assert manager._repository is not None

    @pytest.mark.asyncio
    async def test_cleanup_stale_sandboxes_skips_recent_sandbox(
        self, sandbox_manager_with_mock_redis, sample_sandbox, mocker
    ):
        """Test manual cleanup does not delete sandboxes under the age threshold."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.last_activity_at = time.time() - 3600
        mocker.patch.object(
            manager._repository, "get_active_sandbox_ids", return_value=["12345"]
        )
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        terminate = mocker.patch.object(manager, "terminate_sandbox")

        result = await manager.cleanup_stale_sandboxes(inactive_hours=24)

        assert result["deleted"] == []
        assert result["skipped"][0]["reason"] == "not_stale"
        terminate.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_stale_sandboxes_deletes_old_sandbox(
        self, sandbox_manager_with_mock_redis, sample_sandbox, mocker
    ):
        """Test manual cleanup deletes sandboxes beyond the age threshold."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.last_activity_at = time.time() - (25 * 3600)
        mocker.patch.object(
            manager._repository, "get_active_sandbox_ids", return_value=["12345"]
        )
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        terminate = mocker.patch.object(
            manager,
            "terminate_sandbox",
            new_callable=AsyncMock,
            return_value=(True, "terminated"),
        )

        result = await manager.cleanup_stale_sandboxes(inactive_hours=24)

        assert result["skipped"] == []
        assert result["deleted"][0]["sandbox_id"] == "12345"
        terminate.assert_awaited_once_with("12345")

    @pytest.mark.asyncio
    async def test_cleanup_stale_sandboxes_archives_before_delete(
        self, sandbox_manager_with_mock_redis, sample_sandbox, mocker
    ):
        """Test stale sandbox cleanup archives task files before termination."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.last_activity_at = time.time() - (25 * 3600)
        mocker.patch.object(
            manager._repository, "get_active_sandbox_ids", return_value=["12345"]
        )
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        archive = mocker.patch.object(
            manager,
            "_archive_sandbox_before_cleanup",
            new_callable=AsyncMock,
            return_value=True,
        )
        mocker.patch.object(
            manager,
            "terminate_sandbox",
            new_callable=AsyncMock,
            return_value=(True, "terminated"),
        )

        result = await manager.cleanup_stale_sandboxes(inactive_hours=24)

        assert result["deleted"][0]["sandbox_id"] == "12345"
        archive.assert_awaited_once_with(sample_sandbox)

    @pytest.mark.asyncio
    async def test_cleanup_stale_sandboxes_continues_when_archive_fails(
        self, sandbox_manager_with_mock_redis, sample_sandbox, mocker
    ):
        """Test archive failure does not block stale sandbox termination."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.last_activity_at = time.time() - (25 * 3600)
        mocker.patch.object(
            manager._repository, "get_active_sandbox_ids", return_value=["12345"]
        )
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        mocker.patch.object(
            manager,
            "_archive_sandbox_before_cleanup",
            new_callable=AsyncMock,
            return_value=False,
        )
        terminate = mocker.patch.object(
            manager,
            "terminate_sandbox",
            new_callable=AsyncMock,
            return_value=(True, "terminated"),
        )

        result = await manager.cleanup_stale_sandboxes(inactive_hours=24)

        assert result["deleted"][0]["sandbox_id"] == "12345"
        terminate.assert_awaited_once_with("12345")

    # ----- create_sandbox Tests -----

    @pytest.mark.asyncio
    async def test_create_sandbox_invalid_shell_type(
        self, sandbox_manager_with_mock_redis, mock_redis_client, mocker
    ):
        """Test sandbox creation with invalid shell_type fails during container startup."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None  # No existing sandbox

        # Mock executor to simulate container creation success but health check failure
        # This simulates an invalid shell_type where the container starts but executor fails to initialize
        mock_executor = mocker.MagicMock()
        mock_executor.submit_executor.return_value = {
            "status": "success",
            "executor_name": "test-executor-invalid",
        }

        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        # Mock _wait_for_container_ready to return None immediately (simulating readiness failure)
        # This avoids the 30-second wait from max_retries=30 with interval=1s
        mocker.patch.object(
            manager,
            "_wait_for_container_ready",
            return_value=None,
        )

        sandbox, error = await manager.create_sandbox(
            shell_type="InvalidType",
            user_id=100,
            user_name="testuser",
            metadata={"task_id": 12345},
        )

        # Sandbox is created but fails during container startup/health check
        assert sandbox is not None
        assert sandbox.shell_type == "InvalidType"
        # Container fails to become ready with invalid shell type
        assert error is not None
        assert "failed to become ready" in error

    @pytest.mark.asyncio
    async def test_create_sandbox_reuses_existing(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        mocker,
        sample_sandbox_redis_data,
    ):
        """Test reuses existing active sandbox for same task_id."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data

        # Mock health checker
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={"task_id": 12345},
        )

        assert error is None
        assert sandbox is not None
        assert sandbox.sandbox_id == "12345"

    @pytest.mark.asyncio
    async def test_create_sandbox_container_start_failure(
        self, sandbox_manager_with_mock_redis, mock_redis_client, mocker
    ):
        """Test handling container start failure."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None  # No existing sandbox

        # Mock _start_sandbox_container to return error
        mocker.patch.object(
            manager,
            "_start_sandbox_container",
            new_callable=AsyncMock,
            return_value="Container creation failed",
        )

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={"task_id": 99999},
        )

        assert error == "Container creation failed"

    @pytest.mark.asyncio
    async def test_create_sandbox_restores_archive_after_new_container_starts(
        self, sandbox_manager_with_mock_redis, mock_redis_client, mocker
    ):
        """Test newly created sandboxes restore archived task files when available."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None
        mocker.patch.object(
            manager,
            "_start_sandbox_container",
            new_callable=AsyncMock,
            return_value=None,
        )
        restore = mocker.patch.object(
            manager,
            "_restore_sandbox_after_create",
            new_callable=AsyncMock,
            return_value=True,
        )

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={"task_id": 99999},
        )

        assert error is None
        assert sandbox is not None
        restore.assert_awaited_once_with(sandbox)

    @pytest.mark.asyncio
    async def test_create_sandbox_serializes_concurrent_requests_for_same_task(
        self, sandbox_manager_with_mock_redis, mocker
    ):
        """Test concurrent creates for one task reuse one container startup."""
        manager = sandbox_manager_with_mock_redis
        saved_sandboxes = {}

        def load_sandbox(sandbox_id):
            return saved_sandboxes.get(str(sandbox_id))

        def save_sandbox(sandbox):
            saved_sandboxes[sandbox.sandbox_id] = sandbox
            return True

        start_count = 0
        start_entered = asyncio.Event()
        release_start = asyncio.Event()

        async def start_sandbox(sandbox):
            nonlocal start_count
            start_count += 1
            start_entered.set()
            await release_start.wait()
            sandbox.container_name = "wegent-task-testuser-12345"
            sandbox.set_running("http://localhost:10001")
            save_sandbox(sandbox)
            return None

        mocker.patch.object(
            manager._repository, "load_sandbox", side_effect=load_sandbox
        )
        mocker.patch.object(
            manager._repository, "save_sandbox", side_effect=save_sandbox
        )
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )
        mocker.patch.object(
            manager,
            "_start_sandbox_container",
            new_callable=AsyncMock,
            side_effect=start_sandbox,
        )
        mocker.patch.object(
            manager,
            "_restore_sandbox_after_create",
            new_callable=AsyncMock,
            return_value=True,
        )

        first_create = asyncio.create_task(
            manager.create_sandbox(
                shell_type="ClaudeCode",
                user_id=100,
                user_name="testuser",
                metadata={"task_id": 12345},
            )
        )
        await start_entered.wait()
        second_create = asyncio.create_task(
            manager.create_sandbox(
                shell_type="ClaudeCode",
                user_id=100,
                user_name="testuser",
                metadata={"task_id": 12345},
            )
        )
        await asyncio.sleep(0)
        release_start.set()

        results = await asyncio.gather(first_create, second_create)

        assert start_count == 1
        assert results[0][1] is None
        assert results[1][1] is None
        assert results[0][0] is results[1][0]
        assert results[0][0].base_url == "http://localhost:10001"

    # ----- _build_sandbox_task Tests -----

    def test_build_sandbox_task_basic(
        self, sandbox_manager_with_mock_redis, sample_sandbox
    ):
        """Test building sandbox task structure."""
        manager = sandbox_manager_with_mock_redis

        task = manager._build_sandbox_task(sample_sandbox)

        assert task["type"] == "sandbox"
        assert task["task_id"] == 12345
        assert task["bot"][0]["shell_type"] == "claudecode"
        assert task["user"]["id"] == 100
        assert task["user"]["name"] == "testuser"

    def test_build_sandbox_task_with_workspace(
        self, sandbox_manager_with_mock_redis, sample_sandbox
    ):
        """Test building task with workspace_ref."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.metadata["workspace_ref"] = "workspace-xyz"

        task = manager._build_sandbox_task(sample_sandbox)

        assert task["workspace_ref"] == "workspace-xyz"

    def test_build_sandbox_task_propagates_skill_identity_token(
        self, sandbox_manager_with_mock_redis, sample_sandbox
    ):
        """Test building task forwards skill identity token for container env injection."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.metadata["skill_identity_token"] = "skill-jwt"

        task = manager._build_sandbox_task(sample_sandbox)

        assert task["skill_identity_token"] == "skill-jwt"

    def test_build_sandbox_task_propagates_skip_git_clone(
        self, sandbox_manager_with_mock_redis, sample_sandbox
    ):
        """Test building task forwards skip_git_clone for recovery restores."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.metadata["skip_git_clone"] = True

        task = manager._build_sandbox_task(sample_sandbox)

        assert task["skip_git_clone"] is True

    # ----- get_sandbox Tests -----

    @pytest.mark.asyncio
    async def test_get_sandbox_found(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test returns sandbox when found."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )

        sandbox = await manager.get_sandbox("12345")

        assert sandbox is not None
        assert sandbox.sandbox_id == "12345"

    @pytest.mark.asyncio
    async def test_get_sandbox_not_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns None when not found."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None

        sandbox = await manager.get_sandbox("nonexistent")

        assert sandbox is None

    @pytest.mark.asyncio
    async def test_get_sandbox_health_check_fails(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test status set to FAILED when health check fails."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=False
        )

        sandbox = await manager.get_sandbox("12345", check_health=True)

        assert sandbox is not None
        from executor_manager.models.sandbox import SandboxStatus

        assert sandbox.status == SandboxStatus.FAILED

    # ----- terminate_sandbox Tests -----

    @pytest.mark.asyncio
    async def test_terminate_sandbox_success(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test successful sandbox termination."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )
        mock_executor = MagicMock()
        mock_executor.delete_executor.return_value = {"status": "success"}
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        success, message = await manager.terminate_sandbox("12345")

        assert success is True
        assert "terminated successfully" in message

    @pytest.mark.asyncio
    async def test_terminate_sandbox_not_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns error for non-existent sandbox."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None

        success, message = await manager.terminate_sandbox("nonexistent")

        assert success is False
        assert "not found" in message

    @pytest.mark.asyncio
    async def test_terminate_sandbox_cleans_redis(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test Redis cleanup after termination."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )
        mock_executor = MagicMock()
        mock_executor.delete_executor.return_value = {"status": "success"}
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        await manager.terminate_sandbox("12345")

        mock_redis_client.zrem.assert_called()
        mock_redis_client.delete.assert_called()

    @pytest.mark.asyncio
    async def test_cleanup_sandbox_by_task_id_deletes_by_label_when_saved_name_is_stale(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test task cleanup removes labeled containers when Redis has a stale name."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mock_executor = MagicMock()
        mock_executor.delete_executor.return_value = {
            "status": "unauthorized",
            "error_msg": "stale saved container name",
        }
        mock_executor.delete_executor_by_task_id.return_value = {
            "status": "success",
            "deleted_containers": ["wegent-task-testuser-orphan"],
        }
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        result = await manager.cleanup_sandbox_by_task_id(
            task_id=12345,
            dry_run=False,
            archive_before_delete=False,
        )

        assert result["deleted"] is True
        assert result["redis_cleared"] is True
        assert result["delete_result"]["deleted_containers"] == [
            "wegent-task-testuser-orphan"
        ]
        mock_executor.delete_executor.assert_called_once_with(
            "wegent-task-testuser-12345"
        )
        mock_executor.delete_executor_by_task_id.assert_called_once_with("12345")
        mock_redis_client.zrem.assert_called()
        mock_redis_client.delete.assert_called()

    # ----- keep_alive Tests -----

    @pytest.mark.asyncio
    async def test_keep_alive_success(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test successful timeout extension."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )

        sandbox, error = await manager.keep_alive("12345", additional_timeout=600)

        assert error is None
        assert sandbox is not None

    @pytest.mark.asyncio
    async def test_keep_alive_sandbox_not_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns error for non-existent sandbox."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None

        sandbox, error = await manager.keep_alive("nonexistent")

        assert sandbox is None
        assert "not found" in error

    # ----- create_execution Tests -----

    @pytest.mark.asyncio
    async def test_create_execution_sandbox_not_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns error for non-existent sandbox."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None

        execution, error = await manager.create_execution(
            sandbox_id="nonexistent", prompt="Test prompt", metadata={"subtask_id": 1}
        )

        assert execution is None
        assert "not found" in error

    @pytest.mark.asyncio
    async def test_create_execution_missing_subtask_id(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test requires subtask_id in metadata."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )

        execution, error = await manager.create_execution(
            sandbox_id="12345", prompt="Test prompt", metadata={}  # Missing subtask_id
        )

        assert execution is None
        assert "subtask_id is required" in error

    @pytest.mark.asyncio
    async def test_create_execution_success(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test successful execution creation."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )

        # Mock _run_execution to avoid actual HTTP call
        mocker.patch.object(manager, "_run_execution", new_callable=AsyncMock)

        execution, error = await manager.create_execution(
            sandbox_id="12345", prompt="Test prompt", metadata={"subtask_id": 1}
        )

        assert error is None
        assert execution is not None
        assert execution.prompt == "Test prompt"

    # ----- get_execution Tests -----

    @pytest.mark.asyncio
    async def test_get_execution_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client, sample_execution
    ):
        """Test returns execution when found."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = json.dumps(sample_execution.to_dict())

        execution = await manager.get_execution("12345", subtask_id=1)

        assert execution is not None
        assert execution.sandbox_id == "12345"

    @pytest.mark.asyncio
    async def test_get_execution_not_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns None when not found."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None

        execution = await manager.get_execution("12345", subtask_id=999)

        assert execution is None

    # ----- list_executions Tests -----

    @pytest.mark.asyncio
    async def test_list_executions_success(
        self, sandbox_manager_with_mock_redis, mock_redis_client, sample_execution
    ):
        """Test returns list of executions."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hgetall.return_value = {
            "__sandbox__": "{}",  # Should be skipped
            "1": json.dumps(sample_execution.to_dict()),
        }

        executions, error = await manager.list_executions("12345")

        assert error is None
        assert len(executions) == 1

    @pytest.mark.asyncio
    async def test_list_executions_sandbox_not_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns error for non-existent sandbox."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hgetall.return_value = {}

        # Use a valid numeric sandbox_id
        executions, error = await manager.list_executions("99999")

        assert "not found" in error

    # ----- Redis Operation Tests (via Repository) -----

    def test_save_sandbox_success(
        self, sandbox_manager_with_mock_redis, mock_redis_client, sample_sandbox
    ):
        """Test successful sandbox save to Redis via repository."""
        manager = sandbox_manager_with_mock_redis

        result = manager._repository.save_sandbox(sample_sandbox)

        assert result is True
        mock_redis_client.hset.assert_called()
        mock_redis_client.expire.assert_called()
        mock_redis_client.zadd.assert_called()

    def test_save_sandbox_round_trip_preserves_timing_fields(
        self, sandbox_manager_with_mock_redis, mock_redis_client, sample_sandbox
    ):
        """Test save/load preserves started_at, last_activity_at, and expires_at."""
        manager = sandbox_manager_with_mock_redis

        result = manager._repository.save_sandbox(sample_sandbox)

        assert result is True

        hset_args = mock_redis_client.hset.call_args[0]
        saved_hash_key = hset_args[0]
        saved_field = hset_args[1]
        saved_payload = hset_args[2]
        saved_data = json.loads(saved_payload)

        assert saved_data["started_at"] == sample_sandbox.started_at
        assert saved_data["last_activity_at"] == sample_sandbox.last_activity_at
        assert saved_data["expires_at"] == sample_sandbox.expires_at

        mock_redis_client.hget.return_value = saved_payload
        loaded_sandbox = manager._repository.load_sandbox(sample_sandbox.sandbox_id)

        assert loaded_sandbox is not None
        assert saved_hash_key.endswith(sample_sandbox.sandbox_id)
        assert saved_field == "__sandbox__"
        assert loaded_sandbox.started_at == sample_sandbox.started_at
        assert loaded_sandbox.last_activity_at == sample_sandbox.last_activity_at
        assert loaded_sandbox.expires_at == sample_sandbox.expires_at

    def test_save_sandbox_missing_task_id(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns False without task_id in metadata."""
        from executor_manager.models.sandbox import Sandbox, SandboxStatus

        manager = sandbox_manager_with_mock_redis

        sandbox = Sandbox(
            sandbox_id="test",
            container_name="test-container",
            shell_type="ClaudeCode",
            status=SandboxStatus.PENDING,
            user_id=100,
            user_name="testuser",
            metadata={},  # No task_id
        )

        result = manager._repository.save_sandbox(sandbox)

        assert result is False

    def test_load_sandbox_success(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
    ):
        """Test successful sandbox load from Redis via repository."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data

        sandbox = manager._repository.load_sandbox("12345")

        assert sandbox is not None
        assert sandbox.sandbox_id == "12345"
        assert sandbox.container_name == "wegent-task-testuser-12345"

    def test_load_sandbox_not_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns None when not found via repository."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None

        sandbox = manager._repository.load_sandbox("nonexistent")

        assert sandbox is None

    def test_save_execution_success(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_execution,
        mocker,
    ):
        """Test successful execution save via repository."""
        manager = sandbox_manager_with_mock_redis

        result = manager._repository.save_execution(sample_execution)

        assert result is True
        mock_redis_client.hset.assert_called()

    def test_save_execution_without_update_activity_does_not_update_zset(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_execution,
        mocker,
    ):
        """Test save_execution with update_activity=False does NOT update ZSet timestamp.

        This is the default behavior for execution status updates (running, failed, completed).
        GC timestamp should only be refreshed for new executions.
        """
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.reset_mock()

        result = manager._repository.save_execution(
            sample_execution, update_activity=False
        )

        assert result is True
        mock_redis_client.hset.assert_called()
        mock_redis_client.expire.assert_called()
        # ZSet should NOT be updated for status updates
        mock_redis_client.zadd.assert_not_called()

    def test_save_execution_with_update_activity_updates_zset(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_execution,
        mocker,
    ):
        """Test save_execution with update_activity=True DOES update ZSet timestamp.

        This should be used when creating new executions or on callback to keep sandbox alive.
        """
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.reset_mock()

        result = manager._repository.save_execution(
            sample_execution, update_activity=True
        )

        assert result is True
        mock_redis_client.hset.assert_called()
        mock_redis_client.expire.assert_called()
        # ZSet SHOULD be updated for new executions
        mock_redis_client.zadd.assert_called_once()

    def test_load_execution_success(
        self, sandbox_manager_with_mock_redis, mock_redis_client, sample_execution
    ):
        """Test successful execution load via repository."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = json.dumps(sample_execution.to_dict())

        execution = manager._repository.load_execution(task_id=12345, subtask_id=1)

        assert execution is not None
        assert execution.execution_id == sample_execution.execution_id

    def test_load_execution_not_found(
        self, sandbox_manager_with_mock_redis, mock_redis_client
    ):
        """Test returns None when not found via repository."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None

        execution = manager._repository.load_execution(task_id=12345, subtask_id=999)

        assert execution is None

    def test_dict_to_execution_conversion(
        self, sandbox_manager_with_mock_redis, sample_execution
    ):
        """Test dictionary to Execution object conversion."""
        manager = sandbox_manager_with_mock_redis
        exec_dict = sample_execution.to_dict()

        execution = manager._repository._dict_to_execution(exec_dict)

        assert execution.execution_id == sample_execution.execution_id
        assert execution.sandbox_id == sample_execution.sandbox_id
        assert execution.prompt == sample_execution.prompt

    def test_check_container_health_success(
        self, sandbox_manager_with_mock_redis, mocker
    ):
        """Test returns True for healthy container."""
        manager = sandbox_manager_with_mock_redis
        mock_response = MagicMock()
        mock_response.status_code = 200
        mocker.patch("httpx.get", return_value=mock_response)

        result = manager._health_checker.check_health_sync("http://localhost:10001")

        assert result is True

    def test_check_container_health_failure(
        self, sandbox_manager_with_mock_redis, mocker
    ):
        """Test returns False for unhealthy container."""
        manager = sandbox_manager_with_mock_redis
        mocker.patch("httpx.get", side_effect=Exception("Connection refused"))

        result = manager._health_checker.check_health_sync("http://localhost:10001")

        assert result is False

    # ----- Background Task Tests -----

    # ----- Background Task Tests -----

    @pytest.mark.asyncio
    async def test_check_heartbeats_detects_dead_executor(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test heartbeat check detects dead executors."""
        manager = sandbox_manager_with_mock_redis

        # Create async mock Redis client for repository async methods
        mock_async_redis = MagicMock()
        mock_async_redis.ping = AsyncMock(return_value=True)
        mock_async_redis.zrange = AsyncMock(return_value=["12345"])
        mock_async_redis.hget = AsyncMock(return_value=sample_sandbox_redis_data)

        # Mock the async client getter to return our async mock
        mocker.patch.object(
            manager._repository,
            "_get_async_client",
            new_callable=AsyncMock,
            return_value=mock_async_redis,
        )

        mock_heartbeat = MagicMock()
        # Mock async methods used by _check_heartbeats
        mock_heartbeat.check_heartbeat = AsyncMock(return_value=False)
        mock_heartbeat.get_last_heartbeat = AsyncMock(
            return_value=1704067000.0  # Has last heartbeat
        )
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock _handle_executor_dead
        mock_handle_dead = mocker.patch.object(
            manager, "_handle_executor_dead", new_callable=AsyncMock
        )

        await manager._check_heartbeats()

        mock_handle_dead.assert_called_once_with("12345", 1704067000.0)

    @pytest.mark.asyncio
    async def test_check_heartbeats_detects_dead_with_expired_heartbeat_key(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_metadata,
        mocker,
    ):
        """Test heartbeat check detects dead executor even when heartbeat key expired."""
        manager = sandbox_manager_with_mock_redis

        # Create sandbox data with old created_at (older than grace period)
        old_created_at = 1704067200.0  # Much older than 60s grace period
        last_activity = old_created_at + 100
        old_sandbox_data = json.dumps(
            {
                "sandbox_id": "12345",
                "container_name": "wegent-task-testuser-12345",
                "base_url": "http://localhost:10001",
                "status": "running",
                "created_at": old_created_at,
                "last_activity_at": last_activity,
                "shell_type": "ClaudeCode",
                "user_id": 100,
                "user_name": "testuser",
                "metadata": sample_sandbox_metadata,
            }
        )

        # Create async mock Redis client for repository async methods
        mock_async_redis = MagicMock()
        mock_async_redis.ping = AsyncMock(return_value=True)
        mock_async_redis.zrange = AsyncMock(return_value=["12345"])
        mock_async_redis.hget = AsyncMock(return_value=old_sandbox_data)

        # Mock the async client getter to return our async mock
        mocker.patch.object(
            manager._repository,
            "_get_async_client",
            new_callable=AsyncMock,
            return_value=mock_async_redis,
        )

        mock_heartbeat = MagicMock()
        # Mock async methods used by _check_heartbeats
        mock_heartbeat.check_heartbeat = AsyncMock(return_value=False)
        mock_heartbeat.get_last_heartbeat = AsyncMock(
            return_value=None  # Key expired from Redis!
        )
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock _handle_executor_dead
        mock_handle_dead = mocker.patch.object(
            manager, "_handle_executor_dead", new_callable=AsyncMock
        )

        await manager._check_heartbeats()

        # Should still detect dead executor using sandbox.last_activity_at as fallback
        mock_handle_dead.assert_called_once()
        call_args = mock_handle_dead.call_args[0]
        assert call_args[0] == "12345"
        assert call_args[1] == last_activity  # Uses last_activity_at as fallback

    @pytest.mark.asyncio
    async def test_check_heartbeats_respects_grace_period(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_metadata,
        mocker,
    ):
        """Test heartbeat check respects grace period for new sandboxes."""
        import time

        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrange.return_value = ["12345"]

        # Create sandbox data with recent created_at (within grace period)
        current_time = time.time()
        recent_sandbox_data = json.dumps(
            {
                "sandbox_id": "12345",
                "container_name": "wegent-task-testuser-12345",
                "base_url": "http://localhost:10001",
                "created_at": current_time
                - 10,  # Only 10s old, within 30s grace period
                "shell_type": "ClaudeCode",
                "user_id": 100,
                "user_name": "testuser",
                "metadata": sample_sandbox_metadata,
            }
        )
        mock_redis_client.hget.return_value = recent_sandbox_data

        mock_heartbeat = MagicMock()
        # Mock async methods used by _check_heartbeats
        mock_heartbeat.check_heartbeat = AsyncMock(
            return_value=False
        )  # No heartbeat yet
        mock_heartbeat.get_last_heartbeat = AsyncMock(return_value=None)
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock _handle_executor_dead
        mock_handle_dead = mocker.patch.object(
            manager, "_handle_executor_dead", new_callable=AsyncMock
        )

        await manager._check_heartbeats()

        # Should NOT detect dead executor - within grace period
        mock_handle_dead.assert_not_called()

    @pytest.mark.asyncio
    async def test_handle_executor_dead_terminates_sandbox(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        """Test marks sandbox as failed and cleans up when executor dies."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mock_redis_client.hgetall.return_value = {"__sandbox__": "{}"}

        mock_heartbeat = MagicMock()
        # Mock async method used by _handle_executor_dead
        mock_heartbeat.delete_heartbeat = AsyncMock(return_value=True)
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock ExecutorDispatcher to avoid actual Docker calls
        mock_executor = MagicMock()
        mock_executor.delete_executor.return_value = {"status": "success"}
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        await manager._handle_executor_dead("12345", 1704067000.0)

        # Verify heartbeat key was deleted
        mock_heartbeat.delete_heartbeat.assert_called_once()
        # Verify container deletion was attempted
        mock_executor.delete_executor.assert_called_once()

    async def test_collect_expired_sandboxes_terminates_old(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        mocker,
        sample_sandbox,
    ):
        """Test terminates sandboxes idle for more than two hours."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrange.return_value = ["12345"]
        sample_sandbox.last_activity_at = time.time() - (2 * 3600) - 60
        sample_sandbox.expires_at = time.time() + 3600

        # Mock repository.load_sandbox to return a sandbox
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )

        # Mock terminate_sandbox
        mock_terminate = mocker.patch.object(
            manager,
            "terminate_sandbox",
            new_callable=AsyncMock,
            return_value=(True, "Terminated"),
        )

        await manager._collect_expired_sandboxes()

        mock_terminate.assert_called_once_with("12345")

    @pytest.mark.asyncio
    async def test_collect_expired_sandboxes_cleans_orphaned(
        self, sandbox_manager_with_mock_redis, mock_redis_client, mocker
    ):
        """Test cleans orphaned active set entries."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrange.return_value = ["orphaned-id"]
        mock_redis_client.hget.return_value = None  # No sandbox data

        await manager._collect_expired_sandboxes()

        mock_redis_client.zrem.assert_called_with(
            "wegent-sandbox:active", "orphaned-id"
        )

    @pytest.mark.asyncio
    async def test_collect_expired_sandboxes_skips_unexpired(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        mocker,
        sample_sandbox,
    ):
        """Test keeps sandboxes with recent activity even if expires_at is in the past."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrange.return_value = ["12345"]
        sample_sandbox.last_activity_at = time.time() - 300
        sample_sandbox.expires_at = time.time() - 60

        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        mock_terminate = mocker.patch.object(
            manager,
            "terminate_sandbox",
            new_callable=AsyncMock,
            return_value=(True, "Terminated"),
        )

        await manager._collect_expired_sandboxes()

        mock_terminate.assert_not_called()

    # ----- Scheduler Integration Tests -----

    @pytest.mark.asyncio
    async def test_start_scheduler(self, sandbox_manager_with_mock_redis, mocker):
        """Test scheduler starts successfully."""
        manager = sandbox_manager_with_mock_redis

        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        await manager.start_scheduler()

        mock_scheduler_instance.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_stop_scheduler(self, sandbox_manager_with_mock_redis, mocker):
        """Test scheduler stops successfully."""
        manager = sandbox_manager_with_mock_redis

        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        await manager.start_scheduler()
        mock_scheduler_instance.running = True

        await manager.stop_scheduler()

        mock_scheduler_instance.shutdown.assert_called_once()
