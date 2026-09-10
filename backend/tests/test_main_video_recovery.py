# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify video recovery startup and shutdown without external services."""

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI


@pytest.fixture
def isolated_lifespan(monkeypatch: pytest.MonkeyPatch):
    import app.main as main

    for target in (
        "app.main.setup_logging",
        "app.main.require_internal_service_token_configured",
        "app.main._load_system_initialization_state",
        "app.main.SessionLocal",
        "app.main.start_background_jobs",
        "app.services.builtin_plugin_service.builtin_plugin_service.validate_required_plugins",
        "app.services.task_run_metric_hooks.task_run_metric_hooks.register",
        "app.services.task_run_metric_hooks.task_run_metric_hooks.unregister",
        "app.core.scheduler.start_scheduler",
        "app.core.scheduler.stop_scheduler",
        "app.core.socketio.get_sio",
        "app.services.chat.webpage_ws_chat_emitter.init_ws_emitter",
        "app.services.loop_item_executions.wake.bind_socketio_loop",
        "app.core.events.init_event_bus",
        "app.services.pet.event_handlers.register_pet_event_handlers",
        "app.services.project_automation_completion.register_project_automation_task_completion_handler",
        "app.services.board_team_completion.register_board_team_completion_handler",
        "app.services.device_monitor.start_device_monitor",
        "app.services.loop_items.external_provider.external_loop_item_provider.close",
        "shared.telemetry.core.shutdown_telemetry",
    ):
        monkeypatch.setattr(target, MagicMock())

    for target in (
        "app.main.stop_background_jobs",
        "chat_shell.tools.get_pending_request_registry",
        "chat_shell.tools.shutdown_pending_request_registry",
        "app.services.device_monitor.stop_device_monitor_async",
    ):
        monkeypatch.setattr(target, AsyncMock())

    redis_client = MagicMock()
    redis_client.set.return_value = False
    monkeypatch.setattr(main.redis, "from_url", MagicMock(return_value=redis_client))
    monkeypatch.setattr("app.core.scheduler.get_active_scheduler", lambda: None)

    channels = MagicMock(start_all_enabled=AsyncMock(), stop_all=AsyncMock())
    monkeypatch.setattr("app.services.channels.get_channel_manager", lambda: channels)

    shutdown = MagicMock(initiate_shutdown=AsyncMock(), shutdown_duration=0)
    shutdown.get_active_stream_count.return_value = 0
    monkeypatch.setattr(main, "shutdown_manager", shutdown)

    @asynccontextmanager
    async def mcp_lifespan():
        yield

    monkeypatch.setattr(
        "app.mcp_server.server.mcp_session_managers_lifespan", mcp_lifespan
    )
    return main.lifespan


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
async def test_video_recovery_respects_scheduled_tasks_switch(
    monkeypatch: pytest.MonkeyPatch, isolated_lifespan, enabled: bool
) -> None:
    from app.core.config import settings
    from app.services.execution.agents.video import recovery

    monkeypatch.setattr(settings, "SCHEDULED_TASKS_ENABLED", enabled)
    recover = AsyncMock(return_value=0)
    delayed = AsyncMock(side_effect=asyncio.Event().wait)
    monkeypatch.setattr(recovery, "recover_video_jobs", recover)
    monkeypatch.setattr(recovery, "recover_video_jobs_after_stale_delay", delayed)
    app = FastAPI()
    task = None

    async with isolated_lifespan(app):
        await asyncio.sleep(0)
        if enabled:
            recover.assert_awaited_once_with()
            delayed.assert_awaited_once_with()
            task = app.state.video_recovery_task
            assert not task.done()
        else:
            recover.assert_not_called()
            delayed.assert_not_called()
            assert not hasattr(app.state, "video_recovery_task")

    if enabled:
        assert task.cancelled()
