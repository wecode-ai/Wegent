# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Background polling and recovery roles must not return to Uvicorn."""

from pathlib import Path

MAIN_SOURCE = (Path(__file__).parents[2] / "app/main.py").read_text()
MANAGED_EXECUTION_SOURCE = (
    Path(__file__).parents[2] / "app/services/project_automation_managed_execution.py"
).read_text()


def test_uvicorn_lifespan_does_not_own_maintenance_loops() -> None:
    forbidden_symbols = (
        "start_device_monitor",
        "stop_device_monitor_async",
        "recover_video_jobs",
        "recover_video_jobs_after_stale_delay",
    )

    assert not [symbol for symbol in forbidden_symbols if symbol in MAIN_SOURCE]


def test_request_middleware_does_not_decode_auth_tokens() -> None:
    assert "get_username_from_request" not in MAIN_SOURCE
    assert "jwt.decode" not in MAIN_SOURCE


def test_uvicorn_does_not_register_execution_completion_handlers() -> None:
    forbidden_symbols = (
        "TaskCompletedEvent",
        "handle_task_completed_for_pet",
        "handle_channel_task_completed",
        "register_project_automation_task_completion_handler",
        "register_board_team_completion_handler",
        "conclude_code_wiki_run",
    )

    assert not [symbol for symbol in forbidden_symbols if symbol in MAIN_SOURCE]


def test_web_reachable_cancellation_delegates_terminal_projection() -> None:
    forbidden_symbols = (
        "get_event_bus",
        "register_project_automation_task_completion_handler",
        "register_board_team_completion_handler",
        "cleanup_streaming_state",
    )

    assert "dispatch_execution_event" in MANAGED_EXECUTION_SOURCE
    assert not [
        symbol for symbol in forbidden_symbols if symbol in MANAGED_EXECUTION_SOURCE
    ]
