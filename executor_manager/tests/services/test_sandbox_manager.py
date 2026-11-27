# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for SandboxManager service."""

import asyncio
import copy
import json
import time
from unittest.mock import AsyncMock, MagicMock, call, patch

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
        terminate = mocker.patch.object(manager, "_delete_sandbox_runtime")

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
            "_delete_sandbox_runtime",
            new_callable=AsyncMock,
            return_value={"deleted": True, "redis_cleared": True},
        )

        mocker.patch.object(
            manager, "_archive_sandbox_before_cleanup", new=AsyncMock(return_value=True)
        )
        result = await manager.cleanup_stale_sandboxes(inactive_hours=24)

        assert result["skipped"] == []
        assert result["deleted"][0]["sandbox_id"] == "12345"
        terminate.assert_awaited_once()
        assert terminate.call_args.args[0] == "12345"

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
            "_delete_sandbox_runtime",
            new_callable=AsyncMock,
            return_value={"deleted": True, "redis_cleared": True},
        )

        result = await manager.cleanup_stale_sandboxes(inactive_hours=24)

        assert result["deleted"][0]["sandbox_id"] == "12345"
        archive.assert_awaited_once_with(sample_sandbox)

    @pytest.mark.asyncio
    async def test_cleanup_stale_sandboxes_keeps_runtime_when_archive_fails(
        self, sandbox_manager_with_mock_redis, sample_sandbox, mocker
    ):
        """Test archive failure preserves the only copy of runtime state."""
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
            "_delete_sandbox_runtime",
            new_callable=AsyncMock,
            return_value={"deleted": True},
        )

        result = await manager.cleanup_stale_sandboxes(inactive_hours=24)

        assert result["deleted"] == []
        assert result["failed"][0]["reason"] == "archive_failed"
        terminate.assert_not_awaited()

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
        ensure_workspace = mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            return_value=None,
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
        ensure_workspace.assert_awaited_once_with(sandbox)

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
    async def test_create_sandbox_initializes_workspace_before_restoring_archive(
        self, sandbox_manager_with_mock_redis, mock_redis_client, mocker
    ):
        """Test workspace initialization happens before archive restoration."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None
        call_order = []
        mocker.patch.object(
            manager,
            "_start_sandbox_container",
            new_callable=AsyncMock,
            return_value=None,
        )
        ensure_workspace = mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            side_effect=lambda sandbox: call_order.append("ensure"),
        )
        restore = mocker.patch.object(
            manager,
            "_restore_sandbox_after_create",
            new_callable=AsyncMock,
            side_effect=lambda sandbox: call_order.append("restore") or True,
        )

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={"task_id": 99999},
        )

        assert error is None
        assert sandbox is not None
        ensure_workspace.assert_awaited_once_with(sandbox)
        restore.assert_awaited_once_with(sandbox)
        assert call_order == ["ensure", "restore"]

    @pytest.mark.asyncio
    async def test_create_sandbox_fails_when_workspace_initialization_fails(
        self, sandbox_manager_with_mock_redis, mock_redis_client, mocker
    ):
        """Test a sandbox is not returned as ready without its task workspace."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None
        mocker.patch.object(
            manager,
            "_start_sandbox_container",
            new_callable=AsyncMock,
            return_value=None,
        )
        mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            return_value="Workspace initialization failed",
        )
        restore = mocker.patch.object(
            manager,
            "_restore_sandbox_after_create",
            new_callable=AsyncMock,
        )

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={"task_id": 99999},
        )

        assert error == "Workspace initialization failed"
        assert sandbox.error_message == error
        restore.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_create_sandbox_remains_running_when_archive_restore_fails(
        self, sandbox_manager_with_mock_redis, mock_redis_client, mocker
    ):
        """Test archive restore failure does not block a healthy sandbox."""
        from executor_manager.models.sandbox import SandboxStatus

        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None

        async def start_container(sandbox):
            sandbox.set_running("http://sandbox.example:8080")

        mocker.patch.object(
            manager,
            "_start_sandbox_container",
            new_callable=AsyncMock,
            side_effect=start_container,
        )
        mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            return_value=None,
        )
        restore = mocker.patch.object(
            manager,
            "_restore_sandbox_after_create",
            new_callable=AsyncMock,
            return_value=False,
        )

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={"task_id": 99999},
        )

        assert error is None
        assert sandbox.status == SandboxStatus.RUNNING
        assert sandbox.error_message is None
        restore.assert_awaited_once_with(sandbox)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("prepare_status", [200, 404, 403, 500])
    async def test_ensure_workspace_negotiates_only_missing_legacy_protocol(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mock_httpx_async_client,
        mocker,
        prepare_status,
    ):
        manager = sandbox_manager_with_mock_redis
        url = "http://localhost:10001/api/runtime/prepare"
        first = httpx.Response(
            prepare_status,
            request=httpx.Request("POST", url),
            json={
                "home_path": "/synthetic/home",
                "workspace_path": "/synthetic/workspace/12345",
                "executor_home": "/synthetic/executor",
                "workbench_home": "/synthetic/workbench",
            },
        )
        mkdir = "http://localhost:10001/filesystem.Filesystem/MakeDir"
        existing = httpx.Response(409, request=httpx.Request("POST", mkdir))
        created = httpx.Response(200, request=httpx.Request("POST", mkdir))
        mock_httpx_async_client.post.side_effect = [first, existing, created]
        mocker.patch(
            "executor_manager.services.sandbox.manager.httpx.AsyncClient",
            return_value=mock_httpx_async_client,
        )
        error = await manager._ensure_sandbox_workspace(sample_sandbox)
        calls = [call(url, json={"task_id": 12345})]
        if prepare_status == 404:
            calls += [
                call(
                    mkdir,
                    json={"path": path},
                    headers={"Content-Type": "application/json"},
                )
                for path in ("/home/user", "/workspace/12345")
            ]
        assert mock_httpx_async_client.post.await_args_list == calls
        assert (error is None) == (prepare_status in (200, 404))

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
        mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            return_value=None,
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

    def test_build_sandbox_task_populates_resolved_skills(
        self, sandbox_manager_with_mock_redis, sample_sandbox
    ):
        """Sandbox task should carry every field required by Skill deployment."""
        from executor_manager.services.sandbox.skill_sync import ResolvedTaskSkills

        manager = sandbox_manager_with_mock_redis
        resolved = ResolvedTaskSkills(
            team_namespace="team-a",
            skills=["abtest-file-analyzer", "sandbox"],
            preload_skills=["sandbox"],
            skill_refs={
                "abtest-file-analyzer": {
                    "skill_id": 237510,
                    "namespace": "default",
                }
            },
            preload_skill_refs={"sandbox": {"skill_id": 1, "namespace": "default"}},
            required_skills=["abtest-file-analyzer"],
        )

        task = manager._build_sandbox_task(sample_sandbox, resolved)

        assert task["team_namespace"] == "team-a"
        assert task["skill_names"] == ["abtest-file-analyzer", "sandbox"]
        assert task["preload_skills"] == ["sandbox"]
        assert task["required_skills"] == ["abtest-file-analyzer"]
        assert task["bot"][0]["skills"] == ["abtest-file-analyzer", "sandbox"]
        assert task["bot"][0]["skill_refs"] == resolved.skill_refs

    @pytest.mark.asyncio
    async def test_cold_sandbox_waits_for_required_skills_before_running(
        self, sandbox_manager_with_mock_redis, sample_sandbox, mocker
    ):
        """A cold sandbox must stay pending until the executor confirms Skills."""
        from executor_manager.models.sandbox import SandboxStatus
        from executor_manager.services.sandbox.skill_sync import ResolvedTaskSkills

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.status = SandboxStatus.PENDING
        sample_sandbox.base_url = None
        sample_sandbox.metadata["auth_token"] = "task-jwt"
        resolved = ResolvedTaskSkills(
            skills=["abtest-file-analyzer"],
            required_skills=["abtest-file-analyzer"],
        )
        mocker.patch.object(
            manager._skill_synchronizer,
            "resolve",
            new_callable=AsyncMock,
            return_value=resolved,
        )

        async def sync_before_running(base_url, task, task_skills):
            assert sample_sandbox.status == SandboxStatus.RUNNING
            assert task["required_skills"] == ["abtest-file-analyzer"]
            assert task_skills is resolved
            return {"success": True}

        sync = mocker.patch.object(
            manager._skill_synchronizer,
            "sync",
            new_callable=AsyncMock,
            side_effect=sync_before_running,
        )
        executor = mocker.MagicMock()
        executor.submit_executor.return_value = {
            "status": "success",
            "executor_name": "cold-sandbox",
        }
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=executor,
        )
        mocker.patch.object(
            manager,
            "_wait_for_container_ready",
            new_callable=AsyncMock,
            return_value="http://sandbox:8080",
        )

        async def bind_before_running(base_url, sandbox_id):
            assert sample_sandbox.status == SandboxStatus.PENDING
            assert sample_sandbox.base_url is None
            assert base_url == "http://sandbox:8080"
            assert sandbox_id == sample_sandbox.sandbox_id

        bind = mocker.patch.object(
            manager._runtime_binder,
            "bind",
            new_callable=AsyncMock,
            side_effect=bind_before_running,
        )

        error = await manager._start_sandbox_container(sample_sandbox)

        assert error is None
        assert sample_sandbox.status == SandboxStatus.RUNNING
        assert sample_sandbox.metadata["skill_sync_status"] == "ready"
        assert sample_sandbox.metadata["heartbeat_monitoring"] == "active"
        assert (
            sample_sandbox.metadata["synced_skill_fingerprint"] == resolved.fingerprint
        )
        bind.assert_awaited_once_with("http://sandbox:8080", sample_sandbox.sandbox_id)
        sync.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cold_sandbox_allows_optional_runtime_heartbeat_failure(
        self, sandbox_manager_with_mock_redis, sample_sandbox, mocker
    ):
        """A runtime bind failure must not block a healthy sandbox."""
        from executor_manager.models.sandbox import SandboxStatus
        from executor_manager.services.sandbox.runtime_binding import (
            SandboxRuntimeBindingError,
        )
        from executor_manager.services.sandbox.skill_sync import ResolvedTaskSkills

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.status = SandboxStatus.PENDING
        sample_sandbox.base_url = None
        mocker.patch.object(
            manager._skill_synchronizer,
            "resolve",
            new_callable=AsyncMock,
            return_value=ResolvedTaskSkills(),
        )
        sync = mocker.patch.object(
            manager._skill_synchronizer,
            "sync",
            new_callable=AsyncMock,
        )
        executor = mocker.MagicMock()
        executor.submit_executor.return_value = {
            "status": "success",
            "executor_name": "cold-sandbox",
        }
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=executor,
        )
        mocker.patch.object(
            manager,
            "_wait_for_container_ready",
            new_callable=AsyncMock,
            return_value="http://sandbox:8080",
        )
        mocker.patch.object(
            manager._runtime_binder,
            "bind",
            new_callable=AsyncMock,
            side_effect=SandboxRuntimeBindingError("heartbeat not received"),
        )

        error = await manager._start_sandbox_container(sample_sandbox)

        assert error is None
        assert sample_sandbox.status == SandboxStatus.RUNNING
        assert sample_sandbox.base_url == "http://sandbox:8080"
        assert sample_sandbox.metadata["heartbeat_monitoring"] == "unavailable"
        sync.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_reused_warm_sandbox_syncs_newly_loaded_skill(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        mocker,
        sample_sandbox_redis_data,
    ):
        """A reused warm sandbox must sync Skills loaded after its first use."""
        from executor_manager.services.sandbox.skill_sync import ResolvedTaskSkills

        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )
        ensure_workspace = mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            return_value=None,
        )
        resolved = ResolvedTaskSkills(
            skills=["abtest-file-analyzer"],
            required_skills=["abtest-file-analyzer"],
        )
        mocker.patch.object(
            manager._skill_synchronizer,
            "resolve",
            new_callable=AsyncMock,
            return_value=resolved,
        )
        sync = mocker.patch.object(
            manager._skill_synchronizer,
            "sync",
            new_callable=AsyncMock,
            return_value={"success": True},
        )
        start = mocker.patch.object(manager, "_start_sandbox_container")

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={
                "task_id": 12345,
                "auth_token": "task-jwt",
                "required_skills": '["abtest-file-analyzer"]',
            },
        )

        assert error is None
        assert sandbox.metadata["required_skills"] == ["abtest-file-analyzer"]
        assert sandbox.metadata["synced_skill_fingerprint"] == resolved.fingerprint
        ensure_workspace.assert_awaited_once_with(sandbox)
        sync.assert_awaited_once()
        start.assert_not_called()

    @pytest.mark.asyncio
    async def test_reused_sandbox_skips_unchanged_skill_fingerprint(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """Repeated tool calls must not resync an unchanged Skill plan."""
        from executor_manager.services.sandbox.skill_sync import ResolvedTaskSkills

        manager = sandbox_manager_with_mock_redis
        resolved = ResolvedTaskSkills(
            skills=["abtest-file-analyzer"],
            required_skills=["abtest-file-analyzer"],
            skill_refs={
                "abtest-file-analyzer": {
                    "skill_id": 237510,
                    "namespace": "default",
                    "content_hash": "sha256:abc",
                }
            },
        )
        sample_sandbox.metadata.update(
            {
                "auth_token": "task-jwt",
                "required_skills": ["abtest-file-analyzer"],
                "synced_skill_fingerprint": resolved.fingerprint,
            }
        )
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )
        mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            return_value=None,
        )
        mocker.patch.object(
            manager._skill_synchronizer,
            "resolve",
            new_callable=AsyncMock,
            return_value=resolved,
        )
        sync = mocker.patch.object(
            manager._skill_synchronizer,
            "sync",
            new_callable=AsyncMock,
        )
        start = mocker.patch.object(manager, "_start_sandbox_container")

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={
                "task_id": 12345,
                "auth_token": "task-jwt",
                "required_skills": ["abtest-file-analyzer"],
            },
        )

        assert error is None
        assert sandbox is sample_sandbox
        assert sandbox.metadata["skill_sync_status"] == "ready"
        sync.assert_not_awaited()
        start.assert_not_called()

    def test_reused_sandbox_replaces_request_scoped_required_skills(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
    ):
        """A request-only Skill must not remain required on later turns."""
        sample_sandbox.metadata.update(
            {
                "required_skills": ["wegent-knowledge"],
                "bot_config": "previous-request",
            }
        )

        sandbox_manager_with_mock_redis._merge_activation_metadata(
            sample_sandbox,
            {
                "required_skills": ["abtest-file-analyzer"],
                "bot_config": "current-request",
            },
            None,
        )

        assert sample_sandbox.metadata["required_skills"] == ["abtest-file-analyzer"]
        assert sample_sandbox.metadata["bot_config"] == "current-request"

    @pytest.mark.asyncio
    async def test_reused_sandbox_skill_sync_failure_preserves_runtime(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """Skill activation failure must not mark a healthy runtime as failed."""
        from executor_manager.models.sandbox import SandboxStatus
        from executor_manager.services.sandbox.skill_sync import (
            ResolvedTaskSkills,
            SandboxSkillSyncError,
        )

        manager = sandbox_manager_with_mock_redis
        resolved = ResolvedTaskSkills(
            skills=["abtest-file-analyzer"],
            required_skills=["abtest-file-analyzer"],
        )
        sample_sandbox.metadata["auth_token"] = "task-jwt"
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        save = mocker.patch.object(
            manager._repository, "save_sandbox", return_value=True
        )
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )
        mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            return_value=None,
        )
        mocker.patch.object(
            manager._skill_synchronizer,
            "resolve",
            new_callable=AsyncMock,
            return_value=resolved,
        )
        mocker.patch.object(
            manager._skill_synchronizer,
            "sync",
            new_callable=AsyncMock,
            side_effect=SandboxSkillSyncError("connection reset"),
        )
        start = mocker.patch.object(manager, "_start_sandbox_container")

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={
                "task_id": 12345,
                "auth_token": "task-jwt",
                "required_skills": ["abtest-file-analyzer"],
            },
        )

        assert error == "connection reset"
        assert sandbox is sample_sandbox
        assert sandbox.status == SandboxStatus.RUNNING
        assert sandbox.metadata["skill_sync_status"] == "failed"
        assert sandbox.metadata["last_skill_sync_error"] == "connection reset"
        save.assert_called_with(sample_sandbox)
        start.assert_not_called()

    @pytest.mark.asyncio
    async def test_expired_healthy_sandbox_is_reused_and_renewed(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """A logical lease expiry must not discard a healthy task workspace."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.expires_at = time.time() - 1
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )
        mocker.patch.object(
            manager,
            "_ensure_sandbox_workspace",
            new_callable=AsyncMock,
            return_value=None,
        )
        mocker.patch.object(
            manager,
            "_prepare_sandbox_skills",
            new_callable=AsyncMock,
            return_value=None,
        )
        start = mocker.patch.object(manager, "_start_sandbox_container")

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            timeout=1800,
            metadata={"task_id": 12345},
        )

        assert error is None
        assert sandbox is sample_sandbox
        assert sandbox.expires_at > time.time()
        start.assert_not_called()

    @pytest.mark.asyncio
    async def test_cold_sync_failure_keeps_healthy_container_for_retry(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """A post-start Skill failure must preserve the new healthy container."""
        from executor_manager.models.sandbox import SandboxStatus
        from executor_manager.services.sandbox.skill_sync import (
            ResolvedTaskSkills,
            SandboxSkillSyncError,
        )

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.status = SandboxStatus.PENDING
        sample_sandbox.base_url = None
        resolved = ResolvedTaskSkills(
            skills=["abtest-file-analyzer"],
            required_skills=["abtest-file-analyzer"],
        )
        mocker.patch.object(
            manager._skill_synchronizer,
            "resolve",
            new_callable=AsyncMock,
            return_value=resolved,
        )
        mocker.patch.object(
            manager._skill_synchronizer,
            "sync",
            new_callable=AsyncMock,
            side_effect=SandboxSkillSyncError("sync timeout"),
        )
        executor = mocker.MagicMock()
        executor.submit_executor.return_value = {
            "status": "success",
            "executor_name": "cold-sandbox",
        }
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=executor,
        )
        mocker.patch.object(
            manager,
            "_wait_for_container_ready",
            new_callable=AsyncMock,
            return_value="http://sandbox:8080",
        )
        mocker.patch.object(
            manager._runtime_binder,
            "bind",
            new_callable=AsyncMock,
        )

        error = await manager._start_sandbox_container(sample_sandbox)

        assert error == "sync timeout"
        assert sample_sandbox.status == SandboxStatus.RUNNING
        assert sample_sandbox.base_url == "http://sandbox:8080"
        assert sample_sandbox.metadata["skill_sync_status"] == "failed"

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
    @pytest.mark.parametrize("runtime_status", ["success", "failed", "replaced"])
    async def test_get_sandbox_health_check_fails(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
        runtime_status,
    ):
        """Remove only the unhealthy runtime and return a healthy replacement."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        check_health = mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=False
        )
        if runtime_status == "replaced":
            replacement = json.loads(sample_sandbox_redis_data)
            replacement["container_name"] = "replacement"
            replacement["base_url"] = "http://replacement:8080"
            replacement_data = json.dumps(replacement)
            mock_redis_client.hget.side_effect = [
                sample_sandbox_redis_data,
                replacement_data,
                replacement_data,
            ]
            check_health.side_effect = lambda url: url == replacement["base_url"]
        delete_sandbox = mocker.patch.object(
            manager._repository, "delete_sandbox", return_value=True
        )
        executor = MagicMock()
        executor.delete_executor.return_value = {"status": runtime_status}
        executor.delete_executor_by_task_id.return_value = {"status": runtime_status}
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=executor,
        )

        sandbox = await manager.get_sandbox("12345", check_health=True)

        if runtime_status == "replaced":
            assert sandbox is not None
            assert sandbox.container_name == replacement["container_name"]
            check_health.assert_called_with(replacement["base_url"])
            executor.delete_executor.assert_not_called()
            executor.delete_executor_by_task_id.assert_not_called()
        else:
            assert sandbox is None
        if runtime_status == "success":
            delete_sandbox.assert_called_once_with("12345")
        else:
            delete_sandbox.assert_not_called()

    @pytest.mark.asyncio
    async def test_failed_runtime_removal_does_not_replace_sandbox(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=False
        )
        executor = MagicMock()
        executor.delete_executor.return_value = {"status": "failed"}
        executor.delete_executor_by_task_id.return_value = {"status": "failed"}
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=executor,
        )
        delete_sandbox = mocker.patch.object(manager._repository, "delete_sandbox")
        start_sandbox = mocker.patch.object(manager, "_start_sandbox_container")

        sandbox, error = await manager.create_sandbox(
            shell_type="ClaudeCode",
            user_id=100,
            user_name="testuser",
            metadata={"task_id": 12345},
        )

        assert sandbox.sandbox_id == "12345"
        assert error == "Sandbox replacement blocked: delete_failed"
        delete_sandbox.assert_not_called()
        start_sandbox.assert_not_called()

    # ----- terminate_sandbox Tests -----

    @pytest.mark.asyncio
    @pytest.mark.parametrize("replaced", [False, True])
    async def test_refresh_activity_only_writes_current_sandbox(
        self, sandbox_manager_with_mock_redis, sample_sandbox, mocker, replaced
    ):
        manager = sandbox_manager_with_mock_redis
        current = copy.copy(sample_sandbox)
        if replaced:
            current.created_at += 1
        mocker.patch.object(manager._repository, "load_sandbox", return_value=current)
        save = mocker.patch.object(
            manager._repository, "save_sandbox", return_value=True
        )

        assert await manager.refresh_sandbox_activity(sample_sandbox) is not replaced
        if replaced:
            save.assert_not_called()
        else:
            assert current.last_activity_at > sample_sandbox.last_activity_at
            assert save.call_args.args[0] is current

    @pytest.mark.asyncio
    async def test_repeated_cancellation_keeps_cleanup_lease(
        self, sandbox_manager_with_mock_redis, mocker
    ):
        manager = sandbox_manager_with_mock_redis
        lease = MagicMock()
        lease.lost.is_set.return_value = False
        mocker.patch.object(
            manager, "_try_acquire_task_lifecycle_lease", return_value=lease
        )
        mocker.patch.object(manager._repository, "load_sandbox", return_value=None)
        release = mocker.patch.object(manager, "_release_task_lifecycle_lease")
        started = asyncio.Event()
        finish = asyncio.Event()

        async def delete_runtime(*args, **kwargs):
            started.set()
            await finish.wait()

        mocker.patch.object(
            manager, "_delete_sandbox_runtime", side_effect=delete_runtime
        )
        cleanup = asyncio.create_task(manager._cleanup_selected_sandbox("12345", None))
        await started.wait()
        cleanup.cancel()
        await asyncio.sleep(0)
        cleanup.cancel()
        await asyncio.sleep(0)
        release.assert_not_awaited()

        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await cleanup
        release.assert_awaited_once_with(lease)

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
    @pytest.mark.parametrize("revoke_succeeds", [False, True])
    async def test_terminate_sandbox_cleans_redis(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
        revoke_succeeds,
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

        if not revoke_succeeds:
            from executor_manager.services.sandbox import SandboxTerminationError

            mocker.patch.object(
                manager._repository, "delete_executor_binding", return_value=False
            )
            with pytest.raises(
                SandboxTerminationError, match="sandbox_metadata_cleanup_failed"
            ):
                await manager.terminate_sandbox("12345")
            mock_redis_client.zrem.assert_not_called()
            mock_redis_client.delete.assert_not_called()
            return

        await manager.terminate_sandbox("12345")

        mock_redis_client.zrem.assert_called()
        mock_redis_client.delete.assert_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("lookup_status", ["failed", "not_found", "success"])
    @pytest.mark.parametrize("admin_cleanup", [False, True])
    async def test_sandbox_removal_retries_without_clearing_live_credentials(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
        lookup_status,
        admin_cleanup,
    ):
        from executor_manager.services.sandbox import SandboxTerminationError

        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        executor = mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor"
        ).return_value
        executor.delete_executor.side_effect = [
            {"status": "failed", "error_msg": "runtime temporarily unavailable"},
            {"status": "success"},
        ]
        executor.delete_executor_by_task_id.return_value = {
            "status": lookup_status,
            "deleted_containers": (
                ["wegent-task-testuser-orphan"] if lookup_status == "success" else []
            ),
        }
        revoke = mocker.spy(manager._repository, "delete_executor_binding")

        if admin_cleanup:
            result = await manager.cleanup_sandbox_by_task_id(
                task_id=12345, archive_before_delete=False
            )
            assert result["reason"] == "delete_failed"
            assert result["redis_cleared"] is False
        else:
            with pytest.raises(SandboxTerminationError, match="delete_failed"):
                await manager.terminate_sandbox("12345")

        revoke.assert_not_called()
        mock_redis_client.delete.assert_not_called()
        assert manager._repository.load_sandbox("12345").status.value == "running"

        if admin_cleanup:
            result = await manager.cleanup_sandbox_by_task_id(
                task_id=12345, archive_before_delete=False
            )
            assert result["deleted"] is True
            assert result["redis_cleared"] is True
        else:
            success, _ = await manager.terminate_sandbox("12345")
            assert success is True
        revoke.assert_called_once_with(
            12345, expected_executor_name="wegent-task-testuser-12345", sandbox=True
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("named_status", "label_status", "target_name"),
        [
            ("unauthorized", "success", "wegent-task-testuser-orphan"),
            ("failed", "success", "wegent-task-testuser-12345"),
            ("failed", "not_found", "wegent-task-testuser-12345"),
        ],
    )
    async def test_cleanup_sandbox_by_task_id_can_recover_via_label(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
        named_status,
        label_status,
        target_name,
    ):
        """Label lookup can recover from a stale name or retry the named removal."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mock_executor = MagicMock()
        mock_executor.delete_executor.return_value = {
            "status": named_status,
            "error_msg": "named removal unsuccessful",
        }
        outcome_key = (
            "deleted_containers" if label_status == "success" else "absent_containers"
        )
        label_result = {"status": label_status, outcome_key: [target_name]}
        mock_executor.delete_executor_by_task_id.return_value = label_result
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        result = await manager.cleanup_sandbox_by_task_id(
            task_id=12345,
            dry_run=False,
            archive_before_delete=False,
        )

        assert result["deleted"] is (label_status == "success")
        assert result["redis_cleared"] is True
        assert result["delete_result"] == label_result
        mock_executor.delete_executor.assert_called_once_with(
            "wegent-task-testuser-12345"
        )
        mock_executor.delete_executor_by_task_id.assert_called_once_with(
            "12345", sandbox_only=True
        )
        mock_redis_client.zrem.assert_called()
        mock_redis_client.delete.assert_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("tracked_by_manager", [False, True])
    async def test_admin_cleanup_keeps_orphan_index_until_binding_is_revoked(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        mocker,
        tracked_by_manager,
    ):
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = None
        mock_redis_client.zscore.return_value = 1.0 if tracked_by_manager else None
        executor = mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor"
        ).return_value
        executor.delete_executor_by_task_id.return_value = {"status": "not_found"}
        revoke = mocker.patch.object(
            manager._repository, "delete_executor_binding", side_effect=[False, True]
        )

        result = await manager.cleanup_sandbox_by_task_id(task_id=12345)

        if not tracked_by_manager:
            assert result["redis_cleared"] is True
            revoke.assert_not_called()
            return

        assert result["reason"] == "sandbox_metadata_cleanup_failed"
        assert result["redis_cleared"] is False
        revoke.assert_called_once_with(12345, sandbox=True)
        mock_redis_client.zrem.assert_not_called()

        result = await manager.cleanup_sandbox_by_task_id(task_id=12345)

        assert result["redis_cleared"] is True
        assert revoke.call_count == 2
        mock_redis_client.zrem.assert_any_call(
            manager._repository.active_sandboxes_zset, "12345"
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("reuse_name", [False, True])
    async def test_task_cleanup_preserves_runtime_replaced_during_archive(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
        reuse_name,
    ):
        manager = sandbox_manager_with_mock_redis
        original = json.loads(sample_sandbox_redis_data)
        replacement = {**original, "created_at": original["created_at"] + 1}
        if not reuse_name:
            replacement["container_name"] = "replacement"
        mock_redis_client.hget.return_value = sample_sandbox_redis_data

        async def archive(sandbox):
            assert sandbox.created_at == original["created_at"]
            mock_redis_client.hget.return_value = json.dumps(replacement)
            return True

        mocker.patch.object(
            manager, "_archive_sandbox_before_cleanup", side_effect=archive
        )
        executor = mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor"
        ).return_value

        result = await manager.cleanup_sandbox_by_task_id(task_id=12345)

        assert result["archived"] is True
        assert result["skipped"] is True
        assert result["reason"] == "sandbox_replaced"
        assert result["redis_cleared"] is False
        executor.delete_executor.assert_not_called()
        executor.delete_executor_by_task_id.assert_not_called()
        mock_redis_client.delete.assert_not_called()

    # ----- keep_alive Tests -----

    @pytest.mark.asyncio
    @pytest.mark.parametrize("condition", ["healthy", "replaced", "storage_failed"])
    async def test_keep_alive_revalidates_before_persisting(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        condition,
    ):
        """Renew only the observed runtime and require a successful write."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        if condition == "replaced":
            replacement = json.loads(sample_sandbox_redis_data)
            replacement["created_at"] += 1
            mock_redis_client.hget.side_effect = [
                sample_sandbox_redis_data,
                json.dumps(replacement),
            ]
        elif condition == "storage_failed":
            mock_redis_client.hset.side_effect = OSError("Redis unavailable")

        sandbox, error = await manager.keep_alive("12345", additional_timeout=600)

        if condition == "healthy":
            assert error is None
            assert sandbox is not None
            assert sandbox.expires_at > time.time()
        else:
            assert sandbox is None
            assert error
            if condition == "replaced":
                mock_redis_client.hset.assert_not_called()

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
    @pytest.mark.parametrize("condition", ["healthy", "removed", "storage_failed"])
    async def test_create_execution_success(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
        condition,
    ):
        """Test successful execution creation."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        if condition == "removed":
            mock_redis_client.hget.side_effect = [sample_sandbox_redis_data, None]
        elif condition == "storage_failed":
            mock_redis_client.hset.side_effect = OSError("Redis unavailable")
        else:
            mock_redis_client.expire.side_effect = [
                True,
                OSError("Redis unavailable after sandbox refresh"),
            ]
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )

        # Mock _run_execution to avoid actual HTTP call
        run = mocker.patch.object(manager, "_run_execution", new_callable=AsyncMock)

        if condition == "storage_failed":
            from executor_manager.services.sandbox import SandboxExecutionStorageError

            with pytest.raises(SandboxExecutionStorageError):
                await manager.create_execution(
                    sandbox_id="12345", prompt="Test prompt", metadata={"subtask_id": 1}
                )
            run.assert_not_called()
            return

        execution, error = await manager.create_execution(
            sandbox_id="12345", prompt="Test prompt", metadata={"subtask_id": 1}
        )

        if condition == "healthy":
            assert error is None
            assert execution is not None
            assert execution.prompt == "Test prompt"
            run.assert_called_once()
            mock_redis_client.expire.assert_called_once()
            mock_redis_client.zadd.assert_called_once()
        else:
            assert execution is None
            assert error
            run.assert_not_called()
            if condition == "removed":
                mock_redis_client.hset.assert_not_called()

    @pytest.mark.asyncio
    async def test_create_execution_dispatches_if_request_is_cancelled_during_unlock(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
    ):
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mocker.patch.object(
            manager._health_checker, "check_health_sync", return_value=True
        )
        unlocking = asyncio.Event()
        dispatch = asyncio.Event()
        original_release = manager._release_task_lifecycle_lease

        async def release(lease):
            unlocking.set()
            try:
                await asyncio.Future()
            finally:
                await original_release(lease)

        async def run(sandbox, execution, timeout):
            dispatch.set()

        mocker.patch.object(
            manager, "_release_task_lifecycle_lease", side_effect=release
        )
        mocker.patch.object(manager, "_run_execution", side_effect=run)
        submission = asyncio.create_task(
            manager.create_execution(
                sandbox_id="12345", prompt="Test prompt", metadata={"subtask_id": 1}
            )
        )
        try:
            await asyncio.wait_for(unlocking.wait(), timeout=1)
        finally:
            submission.cancel()
            with pytest.raises(asyncio.CancelledError):
                await submission

        await asyncio.wait_for(dispatch.wait(), timeout=1)

    # ----- get_execution Tests -----

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "change", ["removed_before", "removed_during", "paused", "retried", "completed"]
    )
    async def test_background_execution_rechecks_sandbox_before_dispatch_and_write(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        sample_execution,
        mocker,
        change,
    ):
        from executor_manager.models.sandbox import ExecutionStatus, SandboxStatus

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.expires_at = None
        current = copy.copy(sample_sandbox)
        if change == "paused":
            current.status = SandboxStatus.PENDING
            records = [current, current]
        elif change == "removed_before":
            records = [None, None]
        else:
            records = [current, None if change == "removed_during" else current]
        mocker.patch.object(manager._repository, "load_sandbox", side_effect=records)
        stored = copy.copy(sample_execution)
        updated = copy.copy(stored)
        if change == "retried":
            updated.execution_id = "new-execution"
        elif change == "completed":
            updated.set_completed("Done")
        mocker.patch.object(
            manager._repository, "load_execution", side_effect=[stored, updated]
        )
        save = mocker.patch.object(
            manager._repository, "save_execution", return_value=True
        )
        send = mocker.patch.object(
            manager._execution_runner,
            "send_execution_request",
            return_value=(False, "Connection closed"),
        )

        await manager._run_execution(sample_sandbox, sample_execution, 30)

        if change == "removed_before":
            send.assert_not_awaited()
            save.assert_not_called()
        elif change == "paused":
            send.assert_not_awaited()
            save.assert_called_once_with(sample_execution)
            assert sample_execution.status == ExecutionStatus.FAILED
        else:
            send.assert_awaited_once()
            save.assert_called_once_with(sample_execution)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("completed_before_retry", [False, True])
    async def test_failed_execution_status_write_rechecks_before_retry(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        sample_execution,
        mocker,
        completed_before_retry,
    ):
        from executor_manager.models.sandbox import ExecutionStatus

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.expires_at = None
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        stored = copy.copy(sample_execution)
        fail_terminal_write = True

        def save_execution(state):
            nonlocal stored, fail_terminal_write
            if state.status == ExecutionStatus.FAILED and fail_terminal_write:
                fail_terminal_write = False
                if completed_before_retry:
                    stored.set_completed("Done")
                return False
            stored = copy.copy(state)
            return True

        mocker.patch.object(
            manager._repository, "load_execution", side_effect=lambda *_: stored
        )
        mocker.patch.object(
            manager._repository, "save_execution", side_effect=save_execution
        )
        send = mocker.patch.object(
            manager._execution_runner,
            "send_execution_request",
            return_value=(False, "Connection closed"),
        )

        await manager._run_execution(sample_sandbox, sample_execution, 30)

        send.assert_awaited_once()
        if completed_before_retry:
            assert stored.status == ExecutionStatus.COMPLETED
            assert stored.result == "Done"
        else:
            assert stored.status == ExecutionStatus.FAILED
            assert stored.error_message == "Connection closed"

    @pytest.mark.asyncio
    async def test_lifecycle_lease_uses_canonical_numeric_task_id(
        self, sandbox_manager_with_mock_redis, mocker
    ):
        manager = sandbox_manager_with_mock_redis
        acquire = mocker.patch.object(
            manager._lifecycle_lock, "acquire_owned", return_value="owner-token"
        )
        dispatch_lease, error = await manager._acquire_task_lifecycle_lease("0012345")
        assert error is None
        await manager._release_task_lifecycle_lease(dispatch_lease)
        cleanup_lease = await manager._try_acquire_task_lifecycle_lease("12345")
        await manager._release_task_lifecycle_lease(cleanup_lease)

        assert [call.args[0] for call in acquire.call_args_list] == [
            "task-lifecycle:12345",
            "task-lifecycle:12345",
        ]

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

    def test_save_sandbox_persists_activity_and_expiry_timestamps(
        self, sandbox_manager_with_mock_redis, mock_redis_client, sample_sandbox
    ):
        """Sandbox activity timestamps must survive repository reloads for cleanup."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.started_at = 1704067210.0
        sample_sandbox.last_activity_at = 1704070800.0
        sample_sandbox.expires_at = 1704072600.0

        result = manager._repository.save_sandbox(sample_sandbox)

        assert result is True
        saved_payload = json.loads(mock_redis_client.hset.call_args.args[2])
        assert saved_payload["started_at"] == sample_sandbox.started_at
        assert saved_payload["last_activity_at"] == sample_sandbox.last_activity_at
        assert saved_payload["expires_at"] == sample_sandbox.expires_at

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

    def test_save_execution_does_not_update_zset(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_execution,
        mocker,
    ):
        """Execution status updates refresh the hash TTL without extending GC activity."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.reset_mock()

        result = manager._repository.save_execution(sample_execution)

        assert result is True
        mock_redis_client.hset.assert_called()
        mock_redis_client.expire.assert_called()
        # ZSet should NOT be updated for status updates
        mock_redis_client.zadd.assert_not_called()

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

        handle_timeout = mocker.patch.object(
            manager, "_handle_heartbeat_timeout", new_callable=AsyncMock
        )

        await manager._check_heartbeats()

        handle_timeout.assert_awaited_once_with("12345")

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

        handle_timeout = mocker.patch.object(
            manager, "_handle_heartbeat_timeout", new_callable=AsyncMock
        )

        await manager._check_heartbeats()

        handle_timeout.assert_awaited_once_with("12345")

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
    async def test_check_heartbeats_skips_optional_unavailable_monitoring(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """A sandbox that could not bind heartbeat relies on request-time health."""
        from executor_manager.models.sandbox import SandboxStatus

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.status = SandboxStatus.RUNNING
        sample_sandbox.metadata["heartbeat_monitoring"] = "unavailable"
        mocker.patch.object(
            manager._repository,
            "get_active_sandbox_ids_async",
            new_callable=AsyncMock,
            return_value=["12345"],
        )
        mocker.patch.object(
            manager._repository,
            "load_sandbox_async",
            new_callable=AsyncMock,
            return_value=sample_sandbox,
        )
        heartbeat = MagicMock()
        heartbeat.check_heartbeat = AsyncMock(return_value=False)
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=heartbeat,
        )
        timeout = mocker.patch.object(
            manager,
            "_handle_heartbeat_timeout",
            new_callable=AsyncMock,
        )

        await manager._check_heartbeats()

        heartbeat.check_heartbeat.assert_not_awaited()
        timeout.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_heartbeat_timeout_preserves_healthy_runtime(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """A missing heartbeat alone must not delete a healthy runtime."""
        from executor_manager.models.sandbox import SandboxStatus

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.status = SandboxStatus.RUNNING
        sample_sandbox.base_url = "http://sandbox:8080"
        lease = MagicMock()
        mocker.patch.object(
            manager,
            "_try_acquire_task_lifecycle_lease",
            new_callable=AsyncMock,
            return_value=lease,
        )
        mocker.patch.object(
            manager._repository,
            "load_sandbox_async",
            new_callable=AsyncMock,
            return_value=sample_sandbox,
        )
        heartbeat = MagicMock()
        heartbeat.check_heartbeat = AsyncMock(return_value=False)
        heartbeat.get_last_heartbeat = AsyncMock(return_value=None)
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=heartbeat,
        )
        mocker.patch.object(
            manager,
            "_check_container_health",
            new_callable=AsyncMock,
            return_value=True,
        )
        handle_dead = mocker.patch.object(
            manager,
            "_handle_executor_dead",
            new_callable=AsyncMock,
        )
        release = mocker.patch.object(
            manager,
            "_release_task_lifecycle_lease",
            new_callable=AsyncMock,
        )

        await manager._handle_heartbeat_timeout("12345")

        handle_dead.assert_not_awaited()
        release.assert_awaited_once_with(lease)

    @pytest.mark.asyncio
    async def test_heartbeat_timeout_rechecks_unavailable_monitoring_under_lease(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """An in-flight heartbeat check must honor the latest monitoring state."""
        from executor_manager.models.sandbox import SandboxStatus

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.status = SandboxStatus.RUNNING
        sample_sandbox.metadata["heartbeat_monitoring"] = "unavailable"
        lease = MagicMock()
        mocker.patch.object(
            manager,
            "_try_acquire_task_lifecycle_lease",
            new_callable=AsyncMock,
            return_value=lease,
        )
        mocker.patch.object(
            manager._repository,
            "load_sandbox_async",
            new_callable=AsyncMock,
            return_value=sample_sandbox,
        )
        heartbeat = MagicMock()
        heartbeat.check_heartbeat = AsyncMock(return_value=False)
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=heartbeat,
        )
        check_health = mocker.patch.object(
            manager,
            "_check_container_health",
            new_callable=AsyncMock,
        )
        handle_dead = mocker.patch.object(
            manager,
            "_handle_executor_dead",
            new_callable=AsyncMock,
        )
        release = mocker.patch.object(
            manager,
            "_release_task_lifecycle_lease",
            new_callable=AsyncMock,
        )

        await manager._handle_heartbeat_timeout("12345")

        heartbeat.check_heartbeat.assert_not_awaited()
        check_health.assert_not_awaited()
        handle_dead.assert_not_awaited()
        release.assert_awaited_once_with(lease)

    @pytest.mark.asyncio
    async def test_heartbeat_timeout_deletes_only_unhealthy_runtime(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """A runtime is deleted only after heartbeat and health both fail."""
        from executor_manager.models.sandbox import SandboxStatus

        manager = sandbox_manager_with_mock_redis
        sample_sandbox.status = SandboxStatus.RUNNING
        sample_sandbox.base_url = "http://sandbox:8080"
        sample_sandbox.last_activity_at = 1704067000.0
        lease = MagicMock()
        lease.lost = asyncio.Event()
        mocker.patch.object(
            manager,
            "_try_acquire_task_lifecycle_lease",
            new_callable=AsyncMock,
            return_value=lease,
        )
        mocker.patch.object(
            manager._repository,
            "load_sandbox_async",
            new_callable=AsyncMock,
            return_value=sample_sandbox,
        )
        heartbeat = MagicMock()
        heartbeat.check_heartbeat = AsyncMock(return_value=False)
        heartbeat.get_last_heartbeat = AsyncMock(return_value=None)
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=heartbeat,
        )
        mocker.patch.object(
            manager,
            "_check_container_health",
            new_callable=AsyncMock,
            return_value=False,
        )
        handle_dead = mocker.patch.object(
            manager,
            "_handle_executor_dead",
            new_callable=AsyncMock,
        )
        release = mocker.patch.object(
            manager,
            "_release_task_lifecycle_lease",
            new_callable=AsyncMock,
        )

        await manager._handle_heartbeat_timeout("12345")

        handle_dead.assert_awaited_once_with(sample_sandbox, lease)
        release.assert_awaited_once_with(lease)

    @pytest.mark.asyncio
    async def test_heartbeat_timeout_skips_when_lifecycle_lock_is_busy(
        self,
        sandbox_manager_with_mock_redis,
        mocker,
    ):
        """Another replica's lifecycle operation blocks destructive cleanup."""
        manager = sandbox_manager_with_mock_redis
        mocker.patch.object(
            manager,
            "_try_acquire_task_lifecycle_lease",
            new_callable=AsyncMock,
            return_value=None,
        )
        load = mocker.patch.object(
            manager._repository,
            "load_sandbox_async",
            new_callable=AsyncMock,
        )

        await manager._handle_heartbeat_timeout("12345")

        load.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("delete_status", "revoked", "lease_lost", "storage_failure"),
        [
            ("success", True, False, None),
            ("success", False, False, None),
            ("failed", False, False, None),
            ("success", False, True, None),
            ("success", False, False, "sandbox_write"),
            ("success", False, False, "execution_read"),
            ("success", False, False, "execution_write"),
        ],
    )
    async def test_handle_executor_dead_terminates_sandbox(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        sample_execution,
        mocker,
        delete_status,
        revoked,
        lease_lost,
        storage_failure,
    ):
        """Test marks sandbox as failed and cleans up when executor dies."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.hget.return_value = sample_sandbox_redis_data
        mock_redis_client.hgetall.return_value = {"__sandbox__": "{}"}
        sandbox = manager._repository.load_sandbox("12345")
        lease = MagicMock()
        lease.lost = asyncio.Event()

        mock_heartbeat = MagicMock()
        # Mock async method used by _handle_executor_dead
        mock_heartbeat.delete_heartbeat = AsyncMock(return_value=True)
        mocker.patch(
            "executor_manager.services.sandbox.manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock ExecutorDispatcher to avoid actual Docker calls
        mock_executor = MagicMock()
        loop = asyncio.get_running_loop()

        def delete_container(_name):
            if lease_lost:
                loop.call_soon_threadsafe(lease.lost.set)
            return {"status": delete_status}

        mock_executor.delete_executor.side_effect = delete_container
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )
        revoke = mocker.patch.object(
            manager._repository, "delete_executor_binding", return_value=revoked
        )
        untrack = mocker.patch.object(manager._repository, "remove_from_active_set")
        if storage_failure == "sandbox_write":
            mocker.patch.object(manager._repository, "save_sandbox", return_value=False)
        elif storage_failure == "execution_read":
            mock_redis_client.hgetall.side_effect = OSError("Redis unavailable")
        elif storage_failure == "execution_write":
            sample_execution.set_running()
            mock_redis_client.hgetall.return_value["1"] = json.dumps(
                sample_execution.to_dict()
            )
            mocker.patch.object(
                manager._repository, "save_execution", return_value=False
            )

        await manager._handle_executor_dead(sandbox, lease)

        if storage_failure in {"execution_read", "execution_write"}:
            mock_heartbeat.delete_heartbeat.assert_not_awaited()
            assert sandbox.status.value == "running"
        else:
            mock_heartbeat.delete_heartbeat.assert_awaited_once()
        if storage_failure:
            mock_executor.delete_executor.assert_not_called()
            revoke.assert_not_called()
            untrack.assert_not_called()
            return
        # Verify container deletion was attempted
        mock_executor.delete_executor.assert_called_once()
        if delete_status == "success" and not lease_lost:
            revoke.assert_called_once_with(
                12345, expected_executor_name="wegent-task-testuser-12345", sandbox=True
            )
        else:
            revoke.assert_not_called()
        if revoked:
            untrack.assert_called_once_with("12345")
        else:
            untrack.assert_not_called()

    async def test_collect_expired_sandboxes_terminates_old(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
        sample_sandbox,
    ):
        """Test terminates sandboxes older than 24 hours."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = ["12345"]

        # Mock repository.load_sandbox to return a sandbox
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        mocker.patch.object(
            manager,
            "_archive_before_terminate",
            new_callable=AsyncMock,
            return_value=True,
        )

        # Observe the runtime selected for cleanup
        mock_terminate = mocker.patch.object(
            manager,
            "_delete_sandbox_runtime",
            new_callable=AsyncMock,
            return_value={"deleted": True},
        )

        await manager._collect_expired_sandboxes()

        mock_terminate.assert_awaited_once()
        assert mock_terminate.call_args.args[0] == "12345"

    @pytest.mark.asyncio
    async def test_collect_expired_sandboxes_retries_orphan_revocation(
        self, sandbox_manager_with_mock_redis, mock_redis_client, mocker
    ):
        """An absent runtime stays indexed until its callback binding is revoked."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = ["12345"]
        mock_redis_client.hget.return_value = None  # No sandbox data
        mock_executor = MagicMock()
        mock_executor.delete_executor_by_task_id.side_effect = [
            {"status": "success"},
            {"status": "not_found"},
        ]
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )
        revoke = mocker.patch.object(
            manager._repository, "delete_executor_binding", side_effect=[False, True]
        )

        await manager._collect_expired_sandboxes()

        mock_executor.delete_executor_by_task_id.assert_called_once_with(
            "12345", sandbox_only=True
        )
        revoke.assert_called_once_with(12345, sandbox=True)
        mock_redis_client.zrem.assert_not_called()

        await manager._collect_expired_sandboxes()

        assert revoke.call_count == 2
        mock_redis_client.zrem.assert_any_call(
            manager._repository.active_sandboxes_zset, "12345"
        )
        mock_redis_client.zrem.assert_any_call("wegent-sandbox:active", "12345")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "condition", ["new_session", "busy", "lookup_failed", "new_activity"]
    )
    async def test_collect_expired_sandboxes_skips_orphan_during_activation(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox_redis_data,
        mocker,
        condition,
    ):
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = ["12345"]
        if condition == "new_session":
            mock_redis_client.hget.side_effect = [None, sample_sandbox_redis_data]
        elif condition == "lookup_failed":
            mock_redis_client.hget.side_effect = [None, OSError("Redis unavailable")]
        elif condition == "new_activity":
            mock_redis_client.zscore.return_value = time.time()
        else:
            mock_redis_client.hget.return_value = None
            mocker.patch.object(
                manager, "_try_acquire_task_lifecycle_lease", return_value=None
            )
        executor = mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor"
        ).return_value

        await manager._collect_expired_sandboxes()

        executor.delete_executor_by_task_id.assert_not_called()
        mock_redis_client.zrem.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("supports_label_lookup", [False, True])
    async def test_collect_expired_sandboxes_keeps_orphan_when_delete_fails(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        mocker,
        supports_label_lookup,
    ):
        """A failed orphan delete keeps the entry so the next GC retries."""
        from executor_manager.executors.base import Executor

        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = ["12345"]
        mock_redis_client.hget.return_value = None
        mock_executor = MagicMock()
        if supports_label_lookup:
            mock_executor.delete_executor_by_task_id.return_value = {
                "status": "failed",
                "error_msg": "api unavailable",
            }
        else:
            mock_executor.delete_executor_by_task_id.side_effect = (
                Executor.delete_executor_by_task_id.__get__(mock_executor)
            )
        mocker.patch(
            "executor_manager.services.sandbox.manager.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )
        revoke = mocker.spy(manager._repository, "delete_executor_binding")

        await manager._collect_expired_sandboxes()

        mock_executor.delete_executor_by_task_id.assert_called_once_with(
            "12345", sandbox_only=True
        )
        revoke.assert_not_called()
        mock_redis_client.zrem.assert_not_called()

    @pytest.mark.asyncio
    async def test_collect_expired_sandboxes_defers_when_archive_fails(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox,
        mocker,
    ):
        """Keep the sandbox for a retry instead of losing an unarchived workspace."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = ["12345"]
        sample_sandbox.last_activity_at = time.time() - 25 * 3600
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        mocker.patch.object(
            manager,
            "_archive_sandbox_before_cleanup",
            new_callable=AsyncMock,
            return_value=False,
        )
        mock_terminate = mocker.patch.object(
            manager,
            "_delete_sandbox_runtime",
            new_callable=AsyncMock,
            return_value={"deleted": True},
        )

        await manager._collect_expired_sandboxes()

        mock_terminate.assert_not_called()

    @pytest.mark.asyncio
    async def test_collect_expired_sandboxes_deletes_after_archive_grace(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox,
        mocker,
    ):
        """A broken archive must not pin the Pod forever."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = ["12345"]
        sample_sandbox.last_activity_at = time.time() - 100 * 3600
        mocker.patch.object(
            manager._repository, "load_sandbox", return_value=sample_sandbox
        )
        mocker.patch.object(
            manager,
            "_archive_sandbox_before_cleanup",
            new_callable=AsyncMock,
            return_value=False,
        )
        mock_terminate = mocker.patch.object(
            manager,
            "_delete_sandbox_runtime",
            new_callable=AsyncMock,
            return_value={"deleted": True},
        )

        await manager._collect_expired_sandboxes()

        mock_terminate.assert_awaited_once()
        assert mock_terminate.call_args.args[0] == "12345"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "change", ["renewed", "replaced", "new_execution", "lookup_failed"]
    )
    async def test_collect_expired_sandboxes_preserves_changed_runtime(
        self,
        sandbox_manager_with_mock_redis,
        mock_redis_client,
        sample_sandbox,
        mocker,
        change,
    ):
        """Renewed or replaced sandboxes must survive an in-progress archive."""
        manager = sandbox_manager_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = ["12345"]
        sample_sandbox.last_activity_at = time.time() - 25 * 3600
        renewed = copy.copy(sample_sandbox)
        if change == "renewed":
            renewed.last_activity_at = time.time()
        elif change == "replaced":
            renewed.created_at += 1
        elif change == "new_execution":
            mock_redis_client.zscore.return_value = time.time()
        else:
            mock_redis_client.zscore.side_effect = OSError("Redis unavailable")
        mocker.patch.object(
            manager._repository,
            "load_sandbox",
            side_effect=[sample_sandbox, renewed],
        )
        mocker.patch.object(
            manager,
            "_archive_sandbox_before_cleanup",
            new_callable=AsyncMock,
            return_value=True,
        )
        mock_terminate = mocker.patch.object(
            manager,
            "_delete_sandbox_runtime",
            new_callable=AsyncMock,
            return_value={"deleted": True},
        )

        await manager._collect_expired_sandboxes()

        mock_terminate.assert_not_called()

    @pytest.mark.asyncio
    async def test_archive_before_cleanup_posts_internal_endpoint(
        self,
        sandbox_manager_with_mock_redis,
        sample_sandbox,
        mocker,
    ):
        """GC asks the backend to archive the workspace before deletion."""
        manager = sandbox_manager_with_mock_redis
        sample_sandbox.executor_namespace = "wb-plat-ide"
        response = MagicMock()
        response.status_code = 200
        response.text = "ok"
        client = MagicMock()
        client.post = AsyncMock(return_value=response)
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        mocker.patch(
            "executor_manager.services.sandbox.manager.httpx.AsyncClient",
            return_value=client,
        )

        assert await manager._archive_sandbox_before_cleanup(sample_sandbox) is True

        url = client.post.await_args.args[0]
        assert url.endswith("/api/internal/workspace-archives/12345/archive-sandbox")
        assert client.post.await_args.kwargs["json"] == {
            "executor_name": "wegent-task-testuser-12345",
            "executor_namespace": "wb-plat-ide",
        }

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
