# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for RunningTaskTracker service."""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestRunningTaskTracker:
    """Test cases for RunningTaskTracker class."""

    @pytest.fixture(autouse=True)
    def reset_task_tracker(self):
        """Reset RunningTaskTracker singleton before each test."""
        import executor_manager.services.task_heartbeat_manager as module

        module._running_task_tracker = None

        from executor_manager.services.task_heartbeat_manager import RunningTaskTracker

        RunningTaskTracker._instance = None
        yield
        module._running_task_tracker = None
        RunningTaskTracker._instance = None

    @pytest.fixture
    def tracker_with_mock_redis(self, mocker, mock_redis_client):
        """Create RunningTaskTracker with mocked Redis."""
        mocker.patch(
            "executor_manager.common.redis_factory.RedisClientFactory.get_sync_client",
            return_value=mock_redis_client,
        )
        from executor_manager.services.task_heartbeat_manager import RunningTaskTracker

        tracker = RunningTaskTracker()
        tracker._sync_client = mock_redis_client
        return tracker

    # ----- Singleton Tests -----

    def test_get_instance_returns_singleton(self, mocker, mock_redis_client):
        """Test singleton pattern returns same instance."""
        mocker.patch(
            "executor_manager.common.redis_factory.RedisClientFactory.get_sync_client",
            return_value=mock_redis_client,
        )
        from executor_manager.services.task_heartbeat_manager import RunningTaskTracker

        instance1 = RunningTaskTracker.get_instance()
        instance2 = RunningTaskTracker.get_instance()

        assert instance1 is instance2

    def test_get_running_task_tracker_global_function(self, mocker, mock_redis_client):
        """Test global get_running_task_tracker function."""
        mocker.patch(
            "executor_manager.common.redis_factory.RedisClientFactory.get_sync_client",
            return_value=mock_redis_client,
        )
        from executor_manager.services.task_heartbeat_manager import (
            get_running_task_tracker,
        )

        tracker1 = get_running_task_tracker()
        tracker2 = get_running_task_tracker()

        assert tracker1 is tracker2

    # ----- add_running_task Tests -----

    def test_add_running_task_success(self, tracker_with_mock_redis, mock_redis_client):
        """Test successful task addition."""
        tracker = tracker_with_mock_redis

        result = tracker.add_running_task(
            task_id=123,
            subtask_id=456,
            executor_name="wegent-task-test-123",
            task_type="online",
        )

        assert result is True
        mock_redis_client.zadd.assert_called_once()
        mock_redis_client.hset.assert_called_once()
        mock_redis_client.expire.assert_called_once()

    def test_add_running_task_stores_metadata(
        self, tracker_with_mock_redis, mock_redis_client
    ):
        """Test task metadata is stored correctly."""
        tracker = tracker_with_mock_redis

        tracker.add_running_task(
            task_id=123,
            subtask_id=456,
            executor_name="wegent-task-test-123",
            task_type="online",
        )

        # Verify hset was called with correct metadata
        call_args = mock_redis_client.hset.call_args
        assert call_args[0][0] == "running_task:meta:123"
        mapping = call_args[1]["mapping"]
        assert mapping["task_id"] == "123"
        assert mapping["subtask_id"] == "456"
        assert mapping["executor_name"] == "wegent-task-test-123"
        assert mapping["task_type"] == "online"

    def test_add_running_task_sets_7_day_ttl(
        self, tracker_with_mock_redis, mock_redis_client
    ):
        """Test metadata TTL is set to 7 days by default."""
        tracker = tracker_with_mock_redis

        tracker.add_running_task(
            task_id=123,
            subtask_id=456,
            executor_name="wegent-task-test-123",
        )

        # Verify expire was called with 7 days (604800 seconds)
        mock_redis_client.expire.assert_called_once()
        call_args = mock_redis_client.expire.call_args[0]
        assert call_args[0] == "running_task:meta:123"
        assert call_args[1] == 604800  # 7 days

    def test_add_running_task_no_redis_client(self, tracker_with_mock_redis):
        """Test returns False when Redis client is None."""
        tracker = tracker_with_mock_redis
        tracker._sync_client = None

        result = tracker.add_running_task(
            task_id=123,
            subtask_id=456,
            executor_name="wegent-task-test-123",
        )

        assert result is False

    def test_add_running_task_redis_error(
        self, tracker_with_mock_redis, mock_redis_client
    ):
        """Test handles Redis errors gracefully."""
        tracker = tracker_with_mock_redis
        mock_redis_client.zadd.side_effect = Exception("Redis connection error")

        result = tracker.add_running_task(
            task_id=123,
            subtask_id=456,
            executor_name="wegent-task-test-123",
        )

        assert result is False

    # ----- remove_running_task Tests -----

    def test_remove_running_task_success(
        self, tracker_with_mock_redis, mock_redis_client
    ):
        """Test successful task removal."""
        tracker = tracker_with_mock_redis

        result = tracker.remove_running_task(task_id=123)

        assert result is True
        mock_redis_client.zrem.assert_called_once_with("running_tasks:heartbeat", "123")
        mock_redis_client.delete.assert_called_once_with("running_task:meta:123")

    def test_remove_running_task_no_redis_client(self, tracker_with_mock_redis):
        """Test returns False when Redis client is None."""
        tracker = tracker_with_mock_redis
        tracker._sync_client = None

        result = tracker.remove_running_task(task_id=123)

        assert result is False

    # ----- get_running_task_ids Tests -----

    def test_get_running_task_ids_success(
        self, tracker_with_mock_redis, mock_redis_client
    ):
        """Test getting all running task IDs."""
        tracker = tracker_with_mock_redis
        mock_redis_client.zrange.return_value = [b"123", b"456", b"789"]

        task_ids = tracker.get_running_task_ids()

        assert task_ids == ["123", "456", "789"]
        mock_redis_client.zrange.assert_called_once_with(
            "running_tasks:heartbeat", 0, -1
        )

    def test_get_running_task_ids_empty(
        self, tracker_with_mock_redis, mock_redis_client
    ):
        """Test returns empty list when no tasks."""
        tracker = tracker_with_mock_redis
        mock_redis_client.zrange.return_value = []

        task_ids = tracker.get_running_task_ids()

        assert task_ids == []

    def test_get_running_task_ids_no_redis_client(self, tracker_with_mock_redis):
        """Test returns empty list when Redis client is None."""
        tracker = tracker_with_mock_redis
        tracker._sync_client = None

        task_ids = tracker.get_running_task_ids()

        assert task_ids == []

    # ----- get_task_metadata Tests -----

    def test_get_task_metadata_success(
        self, tracker_with_mock_redis, mock_redis_client
    ):
        """Test getting task metadata."""
        tracker = tracker_with_mock_redis
        mock_redis_client.hgetall.return_value = {
            b"task_id": b"123",
            b"subtask_id": b"456",
            b"executor_name": b"wegent-task-test-123",
            b"task_type": b"online",
            b"start_time": b"1704067200.0",
        }

        metadata = tracker.get_task_metadata(task_id=123)

        assert metadata is not None
        assert metadata["task_id"] == "123"
        assert metadata["subtask_id"] == "456"
        assert metadata["executor_name"] == "wegent-task-test-123"

    def test_get_task_metadata_not_found(
        self, tracker_with_mock_redis, mock_redis_client
    ):
        """Test returns None when task not found."""
        tracker = tracker_with_mock_redis
        mock_redis_client.hgetall.return_value = {}

        metadata = tracker.get_task_metadata(task_id=999)

        assert metadata is None

    # ----- get_stale_tasks Tests -----

    def test_get_stale_tasks_returns_old_tasks(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test get_stale_tasks returns tasks older than max_age_seconds."""
        tracker = tracker_with_mock_redis

        # Mock zrangebyscore to return stale task IDs
        mock_redis_client.zrangebyscore.return_value = [b"123"]

        # Mock hgetall to return task metadata
        mock_redis_client.hgetall.return_value = {
            b"task_id": b"123",
            b"subtask_id": b"456",
            b"executor_name": b"wegent-task-test-123",
            b"task_type": b"online",
            b"start_time": b"1704067200.0",
        }

        stale_tasks = tracker.get_stale_tasks(max_age_seconds=30)

        assert len(stale_tasks) == 1
        assert stale_tasks[0]["task_id"] == "123"

    def test_get_stale_tasks_filters_by_cutoff_time(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test get_stale_tasks uses correct cutoff time."""
        tracker = tracker_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = []

        current_time = time.time()
        mocker.patch("time.time", return_value=current_time)

        tracker.get_stale_tasks(max_age_seconds=60)

        # Verify zrangebyscore was called with correct cutoff
        call_args = mock_redis_client.zrangebyscore.call_args[0]
        assert call_args[0] == "running_tasks:heartbeat"
        assert call_args[1] == "-inf"
        # cutoff_time should be current_time - 60
        assert abs(float(call_args[2]) - (current_time - 60)) < 1

    def test_get_stale_tasks_empty(self, tracker_with_mock_redis, mock_redis_client):
        """Test returns empty list when no stale tasks."""
        tracker = tracker_with_mock_redis
        mock_redis_client.zrangebyscore.return_value = []

        stale_tasks = tracker.get_stale_tasks(max_age_seconds=30)

        assert stale_tasks == []

    # ----- check_heartbeats Tests -----

    @pytest.mark.asyncio
    async def test_check_heartbeats_skips_within_grace_period(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test check_heartbeats skips tasks within grace period."""
        tracker = tracker_with_mock_redis

        # Mock distributed lock (imported inside method)
        mock_lock = MagicMock()
        mock_lock.acquire.return_value = True
        mocker.patch(
            "executor_manager.common.distributed_lock.get_distributed_lock",
            return_value=mock_lock,
        )

        # Mock heartbeat manager (imported inside method)
        mock_heartbeat = MagicMock()
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock get_stale_tasks to return empty (no tasks past grace period)
        mocker.patch.object(tracker, "get_stale_tasks", return_value=[])

        # Mock _handle_task_dead
        mock_handle_dead = mocker.patch.object(
            tracker, "_handle_task_dead", new_callable=AsyncMock
        )

        await tracker.check_heartbeats()

        # Should not call _handle_task_dead
        mock_handle_dead.assert_not_called()

    @pytest.mark.asyncio
    async def test_check_heartbeats_detects_dead_task(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test check_heartbeats detects task without heartbeat."""
        tracker = tracker_with_mock_redis

        # Mock distributed lock (imported inside method)
        mock_lock = MagicMock()
        mock_lock.acquire.return_value = True
        mocker.patch(
            "executor_manager.common.distributed_lock.get_distributed_lock",
            return_value=mock_lock,
        )

        # Mock get_stale_tasks to return a task that's past grace period
        old_start_time = time.time() - 120  # 2 minutes old
        mocker.patch.object(
            tracker,
            "get_stale_tasks",
            return_value=[
                {
                    "task_id": "123",
                    "subtask_id": "456",
                    "executor_name": "wegent-task-test-123",
                    "start_time": str(old_start_time),
                }
            ],
        )

        # Mock heartbeat manager - no heartbeat
        mock_heartbeat = MagicMock()
        mock_heartbeat.check_heartbeat.return_value = False
        mock_heartbeat.get_last_heartbeat.return_value = None
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock _handle_task_dead
        mock_handle_dead = mocker.patch.object(
            tracker, "_handle_task_dead", new_callable=AsyncMock
        )

        await tracker.check_heartbeats()

        mock_handle_dead.assert_called_once()
        call_args = mock_handle_dead.call_args[1]
        assert call_args["task_id_str"] == "123"
        assert call_args["subtask_id_str"] == "456"
        assert call_args["executor_name"] == "wegent-task-test-123"

    @pytest.mark.asyncio
    async def test_check_heartbeats_skips_healthy_task(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test check_heartbeats skips task with valid heartbeat."""
        tracker = tracker_with_mock_redis

        # Mock distributed lock (imported inside method)
        mock_lock = MagicMock()
        mock_lock.acquire.return_value = True
        mocker.patch(
            "executor_manager.common.distributed_lock.get_distributed_lock",
            return_value=mock_lock,
        )

        # Mock get_stale_tasks to return a task
        mocker.patch.object(
            tracker,
            "get_stale_tasks",
            return_value=[
                {
                    "task_id": "123",
                    "subtask_id": "456",
                    "executor_name": "wegent-task-test-123",
                    "start_time": str(time.time() - 60),
                }
            ],
        )

        # Mock heartbeat manager - heartbeat is alive
        mock_heartbeat = MagicMock()
        mock_heartbeat.check_heartbeat.return_value = True
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock _handle_task_dead
        mock_handle_dead = mocker.patch.object(
            tracker, "_handle_task_dead", new_callable=AsyncMock
        )

        await tracker.check_heartbeats()

        # Should not call _handle_task_dead - task is healthy
        mock_handle_dead.assert_not_called()

    @pytest.mark.asyncio
    async def test_check_heartbeats_skips_if_lock_not_acquired(
        self, tracker_with_mock_redis, mocker
    ):
        """Test check_heartbeats skips if distributed lock not acquired."""
        tracker = tracker_with_mock_redis

        # Mock distributed lock - cannot acquire (imported inside method)
        mock_lock = MagicMock()
        mock_lock.acquire.return_value = False
        mocker.patch(
            "executor_manager.common.distributed_lock.get_distributed_lock",
            return_value=mock_lock,
        )

        # Mock get_stale_tasks - should not be called
        mock_get_stale = mocker.patch.object(tracker, "get_stale_tasks")

        await tracker.check_heartbeats()

        # Should not check tasks since lock not acquired
        mock_get_stale.assert_not_called()

    # ----- _handle_task_dead Tests -----

    @pytest.mark.asyncio
    async def test_handle_task_dead_running_container_skips(
        self, tracker_with_mock_redis, mocker
    ):
        """Test _handle_task_dead skips if container is still running."""
        tracker = tracker_with_mock_redis

        # Mock executor - container still running (imported inside method)
        mock_executor = MagicMock()
        mock_executor.get_container_status.return_value = {
            "exists": True,
            "status": "running",
            "oom_killed": False,
            "exit_code": 0,
            "error_msg": None,
        }
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        # Mock heartbeat manager (imported inside method)
        mock_heartbeat = MagicMock()
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        await tracker._handle_task_dead(
            task_id_str="123",
            subtask_id_str="456",
            executor_name="wegent-task-test-123",
            last_heartbeat=time.time() - 60,
        )

        # Should not mark as failed - container is running
        mock_heartbeat.delete_heartbeat.assert_not_called()

    @pytest.mark.asyncio
    async def test_handle_task_dead_oom_killed(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test _handle_task_dead handles OOM killed container."""
        tracker = tracker_with_mock_redis

        # Mock executor - OOM killed (imported inside method)
        mock_executor = MagicMock()
        mock_executor.get_container_status.return_value = {
            "exists": True,
            "status": "exited",
            "oom_killed": True,
            "exit_code": 137,
            "error_msg": None,
        }
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        # Mock heartbeat manager (imported inside method)
        mock_heartbeat = MagicMock()
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock TaskApiClient (imported inside method)
        mock_api_client = MagicMock()
        mock_api_client.update_task_status_by_fields.return_value = (True, {})
        mocker.patch(
            "executor_manager.clients.task_api_client.TaskApiClient",
            return_value=mock_api_client,
        )

        await tracker._handle_task_dead(
            task_id_str="123",
            subtask_id_str="456",
            executor_name="wegent-task-test-123",
            last_heartbeat=time.time() - 60,
        )

        # Verify task marked as failed with OOM message
        mock_api_client.update_task_status_by_fields.assert_called_once()
        call_kwargs = mock_api_client.update_task_status_by_fields.call_args[1]
        assert call_kwargs["status"] == "FAILED"
        assert "Out Of Memory" in call_kwargs["error_message"]

        # Verify cleanup
        mock_heartbeat.delete_heartbeat.assert_called_once()

    @pytest.mark.asyncio
    async def test_handle_task_dead_exit_code_137(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test _handle_task_dead handles SIGKILL (exit code 137)."""
        tracker = tracker_with_mock_redis

        # Mock executor - exit code 137 (imported inside method)
        mock_executor = MagicMock()
        mock_executor.get_container_status.return_value = {
            "exists": True,
            "status": "exited",
            "oom_killed": False,
            "exit_code": 137,
            "error_msg": None,
        }
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        # Mock heartbeat manager (imported inside method)
        mock_heartbeat = MagicMock()
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock TaskApiClient (imported inside method)
        mock_api_client = MagicMock()
        mock_api_client.update_task_status_by_fields.return_value = (True, {})
        mocker.patch(
            "executor_manager.clients.task_api_client.TaskApiClient",
            return_value=mock_api_client,
        )

        await tracker._handle_task_dead(
            task_id_str="123",
            subtask_id_str="456",
            executor_name="wegent-task-test-123",
            last_heartbeat=time.time() - 60,
        )

        # Verify error message mentions SIGKILL
        call_kwargs = mock_api_client.update_task_status_by_fields.call_args[1]
        assert "SIGKILL" in call_kwargs["error_message"]
        assert "137" in call_kwargs["error_message"]

    @pytest.mark.asyncio
    async def test_handle_task_dead_exit_code_0_skips_failure(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test _handle_task_dead skips failure marking for exit code 0."""
        tracker = tracker_with_mock_redis

        # Mock executor - normal exit (imported inside method)
        mock_executor = MagicMock()
        mock_executor.get_container_status.return_value = {
            "exists": True,
            "status": "exited",
            "oom_killed": False,
            "exit_code": 0,
            "error_msg": None,
        }
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        # Mock heartbeat manager (imported inside method)
        mock_heartbeat = MagicMock()
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock TaskApiClient (imported inside method)
        mock_api_client = MagicMock()
        mocker.patch(
            "executor_manager.clients.task_api_client.TaskApiClient",
            return_value=mock_api_client,
        )

        await tracker._handle_task_dead(
            task_id_str="123",
            subtask_id_str="456",
            executor_name="wegent-task-test-123",
            last_heartbeat=time.time() - 60,
        )

        # Should NOT mark as failed - normal exit
        mock_api_client.update_task_status_by_fields.assert_not_called()

        # But should cleanup
        mock_heartbeat.delete_heartbeat.assert_called_once()

    @pytest.mark.asyncio
    async def test_handle_task_dead_container_not_found_checks_backend(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test _handle_task_dead checks backend when container not found."""
        tracker = tracker_with_mock_redis

        # Mock executor - container not found (imported inside method)
        mock_executor = MagicMock()
        mock_executor.get_container_status.return_value = {
            "exists": False,
            "status": "not_found",
            "oom_killed": False,
            "exit_code": -1,
            "error_msg": None,
        }
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        # Mock heartbeat manager (imported inside method)
        mock_heartbeat = MagicMock()
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock TaskApiClient - task already completed (imported inside method)
        mock_api_client = MagicMock()
        mock_api_client.get_task_status.return_value = {"status": "COMPLETED"}
        mocker.patch(
            "executor_manager.clients.task_api_client.TaskApiClient",
            return_value=mock_api_client,
        )

        await tracker._handle_task_dead(
            task_id_str="123",
            subtask_id_str="456",
            executor_name="wegent-task-test-123",
            last_heartbeat=time.time() - 60,
        )

        # Should check task status from backend
        mock_api_client.get_task_status.assert_called_once_with(123, 456)

        # Should NOT mark as failed - task already completed
        mock_api_client.update_task_status_by_fields.assert_not_called()

        # Should cleanup tracker
        mock_heartbeat.delete_heartbeat.assert_called_once()

    @pytest.mark.asyncio
    async def test_handle_task_dead_container_not_found_marks_failed(
        self, tracker_with_mock_redis, mock_redis_client, mocker
    ):
        """Test _handle_task_dead marks failed when container not found and task running."""
        tracker = tracker_with_mock_redis

        # Mock executor - container not found (imported inside method)
        mock_executor = MagicMock()
        mock_executor.get_container_status.return_value = {
            "exists": False,
            "status": "not_found",
            "oom_killed": False,
            "exit_code": -1,
            "error_msg": None,
        }
        mocker.patch(
            "executor_manager.executors.dispatcher.ExecutorDispatcher.get_executor",
            return_value=mock_executor,
        )

        # Mock heartbeat manager (imported inside method)
        mock_heartbeat = MagicMock()
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        # Mock TaskApiClient - task still running (imported inside method)
        mock_api_client = MagicMock()
        mock_api_client.get_task_status.return_value = {"status": "RUNNING"}
        mock_api_client.update_task_status_by_fields.return_value = (True, {})
        mocker.patch(
            "executor_manager.clients.task_api_client.TaskApiClient",
            return_value=mock_api_client,
        )

        await tracker._handle_task_dead(
            task_id_str="123",
            subtask_id_str="456",
            executor_name="wegent-task-test-123",
            last_heartbeat=time.time() - 60,
        )

        # Should mark as failed
        mock_api_client.update_task_status_by_fields.assert_called_once()
        call_kwargs = mock_api_client.update_task_status_by_fields.call_args[1]
        assert call_kwargs["status"] == "FAILED"
        assert "removed unexpectedly" in call_kwargs["error_message"]

    @pytest.mark.asyncio
    async def test_handle_task_dead_invalid_task_id(
        self, tracker_with_mock_redis, mocker
    ):
        """Test _handle_task_dead handles invalid task_id gracefully."""
        tracker = tracker_with_mock_redis

        # Mock heartbeat manager (imported inside method)
        mock_heartbeat = MagicMock()
        mocker.patch(
            "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
            return_value=mock_heartbeat,
        )

        await tracker._handle_task_dead(
            task_id_str="invalid",
            subtask_id_str="456",
            executor_name="wegent-task-test-123",
            last_heartbeat=time.time() - 60,
        )

        # Should return early without error
        mock_heartbeat.delete_heartbeat.assert_not_called()
