# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for SandboxScheduler service."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestSandboxScheduler:
    """Test cases for SandboxScheduler class."""

    @pytest.fixture
    def mock_sandbox_manager(self, mocker):
        """Create mock SandboxManager for testing."""
        mock_manager = mocker.MagicMock()
        mock_manager._check_heartbeats = mocker.AsyncMock()
        mock_manager._collect_expired_sandboxes = mocker.AsyncMock()
        return mock_manager

    @pytest.fixture
    def sandbox_scheduler(self, mock_sandbox_manager):
        """Create SandboxScheduler with mocked SandboxManager."""
        from executor_manager.services.sandbox import SandboxScheduler

        return SandboxScheduler(mock_sandbox_manager)

    # ----- Initialization Tests -----

    def test_init_with_sandbox_manager(self, mock_sandbox_manager):
        """Test initialization with SandboxManager."""
        from executor_manager.services.sandbox import SandboxScheduler

        scheduler = SandboxScheduler(mock_sandbox_manager)

        assert scheduler._sandbox_manager is mock_sandbox_manager

    def test_init_scheduler_is_none(self, sandbox_scheduler):
        """Test scheduler is None before start."""
        assert sandbox_scheduler._scheduler is None

    # ----- start Tests -----

    @pytest.mark.asyncio
    async def test_start_creates_scheduler(self, sandbox_scheduler, mocker):
        """Test start creates AsyncIOScheduler."""
        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        await sandbox_scheduler.start()

        mock_scheduler_class.assert_called_once()
        mock_scheduler_instance.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_adds_heartbeat_job(self, sandbox_scheduler, mocker):
        """Test heartbeat check job is added."""
        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        await sandbox_scheduler.start()

        add_job_calls = mock_scheduler_instance.add_job.call_args_list
        heartbeat_job = next(
            (
                call
                for call in add_job_calls
                if call.kwargs.get("id") == "heartbeat_check"
            ),
            None,
        )
        assert heartbeat_job is not None

    @pytest.mark.asyncio
    async def test_start_adds_gc_job(self, sandbox_scheduler, mocker):
        """Test sandbox GC job is added."""
        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        await sandbox_scheduler.start()

        add_job_calls = mock_scheduler_instance.add_job.call_args_list
        gc_job = next(
            (call for call in add_job_calls if call.kwargs.get("id") == "sandbox_gc"),
            None,
        )
        assert gc_job is not None

    @pytest.mark.asyncio
    async def test_start_already_running(self, sandbox_scheduler, mocker):
        """Test start logs warning if already running."""
        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        # Start first time
        await sandbox_scheduler.start()

        # Set running to True
        mock_scheduler_instance.running = True

        # Start again - should not create new scheduler
        await sandbox_scheduler.start()

        # AsyncIOScheduler should only be instantiated once
        assert mock_scheduler_class.call_count == 1

    @pytest.mark.asyncio
    async def test_start_job_intervals(self, sandbox_scheduler, mocker):
        """Test jobs use correct intervals from env vars."""
        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        mocker.patch(
            "executor_manager.services.sandbox.scheduler.ExecutorDispatcher.registered_executors",
            return_value=(),
        )

        # Patch the interval trigger to capture intervals
        mocker.patch("executor_manager.services.sandbox.scheduler.IntervalTrigger")

        await sandbox_scheduler.start()

        # Verify four jobs were added: sandbox_heartbeat_check,
        # task_heartbeat_check, sandbox_gc and queue_stall_check.
        assert mock_scheduler_instance.add_job.call_count == 4

    @pytest.mark.asyncio
    async def test_callback_renewal_covers_all_configured_executors(
        self, sandbox_scheduler, mocker
    ):
        from executor_manager.services.sandbox import scheduler

        docker = mocker.Mock()
        secondary = mocker.Mock()
        mocker.patch.object(
            scheduler.ExecutorDispatcher,
            "registered_executors",
            return_value=[
                ("docker", docker),
                ("secondary", secondary),
                ("without_renewal", object()),
            ],
        )
        mocker.patch.object(
            scheduler,
            "get_config",
            return_value=mocker.Mock(executor=mocker.Mock(executor_binding_ttl=30)),
        )
        clock_start = scheduler.datetime.now(scheduler.timezone.utc)
        scheduler_instance = mocker.patch.object(
            scheduler, "AsyncIOScheduler"
        ).return_value

        await sandbox_scheduler.start()

        jobs = {
            call.kwargs["id"]: call
            for call in scheduler_instance.add_job.call_args_list
            if call.kwargs["id"].startswith("executor_callback_lease_")
        }
        assert set(jobs) == {
            "executor_callback_lease_docker",
            "executor_callback_lease_secondary",
        }
        for name, executor in (("docker", docker), ("secondary", secondary)):
            job = jobs[f"executor_callback_lease_{name}"]
            assert job.args[1].interval.total_seconds() == 10
            assert (
                clock_start
                <= job.kwargs["next_run_time"]
                <= scheduler.datetime.now(scheduler.timezone.utc)
            )
            await job.args[0](*job.kwargs["args"])
            executor.renew_callback_bindings.assert_called_once_with()

    # ----- stop Tests -----

    @pytest.mark.asyncio
    async def test_stop_shuts_down_scheduler(self, sandbox_scheduler, mocker):
        """Test stop shuts down scheduler."""
        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        await sandbox_scheduler.start()
        mock_scheduler_instance.running = True

        await sandbox_scheduler.stop()

        mock_scheduler_instance.shutdown.assert_called_once_with(wait=False)

    @pytest.mark.asyncio
    async def test_stop_sets_scheduler_none(self, sandbox_scheduler, mocker):
        """Test stop sets scheduler to None."""
        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        await sandbox_scheduler.start()
        mock_scheduler_instance.running = True

        await sandbox_scheduler.stop()

        assert sandbox_scheduler._scheduler is None

    @pytest.mark.asyncio
    async def test_stop_when_not_running(self, sandbox_scheduler):
        """Test stop handles not running gracefully."""
        # Should not raise exception
        await sandbox_scheduler.stop()

        assert sandbox_scheduler._scheduler is None

    # ----- is_running Property Tests -----

    def test_is_running_true_when_started(self, sandbox_scheduler, mocker):
        """Test returns True when scheduler is running."""
        mock_scheduler = MagicMock()
        mock_scheduler.running = True
        sandbox_scheduler._scheduler = mock_scheduler

        assert sandbox_scheduler.is_running is True

    def test_is_running_false_when_stopped(self, sandbox_scheduler, mocker):
        """Test returns False when scheduler is stopped."""
        mock_scheduler = MagicMock()
        mock_scheduler.running = False
        sandbox_scheduler._scheduler = mock_scheduler

        assert sandbox_scheduler.is_running is False

    def test_is_running_false_when_not_initialized(self, sandbox_scheduler):
        """Test returns False when scheduler is None."""
        assert sandbox_scheduler._scheduler is None
        assert sandbox_scheduler.is_running is False

    # ----- Integration with SandboxManager -----

    @pytest.mark.asyncio
    async def test_scheduler_calls_correct_manager_methods(
        self, mock_sandbox_manager, mocker
    ):
        """Test scheduler jobs are configured with correct manager methods."""
        from executor_manager.services.sandbox import SandboxScheduler

        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        scheduler = SandboxScheduler(mock_sandbox_manager)
        await scheduler.start()

        # Get the job functions that were passed to add_job
        add_job_calls = mock_scheduler_instance.add_job.call_args_list

        # First job should be sandbox heartbeat check
        heartbeat_job_func = add_job_calls[0][0][0]
        assert heartbeat_job_func == mock_sandbox_manager._check_heartbeats

        # Second job is task heartbeat check (from RunningTaskTracker), skip verification

        # Third job should be sandbox GC
        gc_job_func = add_job_calls[2][0][0]
        assert gc_job_func == mock_sandbox_manager._collect_expired_sandboxes

    @pytest.mark.asyncio
    async def test_scheduler_job_defaults(self, sandbox_scheduler, mocker):
        """Test scheduler job defaults are configured correctly."""
        mock_scheduler_class = mocker.patch(
            "executor_manager.services.sandbox.scheduler.AsyncIOScheduler"
        )
        mock_scheduler_instance = MagicMock()
        mock_scheduler_instance.running = False
        mock_scheduler_class.return_value = mock_scheduler_instance

        await sandbox_scheduler.start()

        # Check job_defaults passed to AsyncIOScheduler
        call_kwargs = mock_scheduler_class.call_args[1]
        job_defaults = call_kwargs.get("job_defaults", {})
        assert job_defaults.get("coalesce") is True
        assert job_defaults.get("max_instances") == 1
        assert job_defaults.get("misfire_grace_time") == 30
