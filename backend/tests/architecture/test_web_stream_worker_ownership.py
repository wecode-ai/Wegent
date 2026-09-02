# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep Web-facing stream lifecycles out of the sole Uvicorn process."""

from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"


def _function_source(relative_path: str, name: str) -> str:
    path = APP_ROOT / relative_path
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    function = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    )
    return ast.unparse(function)


def test_model_runtime_stream_is_transport_only() -> None:
    source = _function_source(
        "api/endpoints/adapter/model_runtime.py",
        "create_stateless_response",
    )
    assert "web_stream_worker_client.stream" in source
    assert "MODEL_RUNTIME_STREAM" in source
    assert "stateless_runtime_service.stream_response" not in source
    assert "web_stream_worker_client.execute" in source
    assert "MODEL_RUNTIME_EXECUTE" in source
    assert "stateless_runtime_service.complete_text" not in source


def test_prompt_draft_stream_is_transport_only_after_bounded_db_preparation() -> None:
    source = _function_source(
        "api/endpoints/adapter/tasks.py",
        "generate_task_prompt_draft_stream",
    )
    assert "web_stream_worker_client.stream" in source
    assert "PROMPT_DRAFT_STREAM" in source
    assert "run_sync_in_executor" in source
    assert "generate_prompt_draft_stream" not in source


def test_wizard_stream_is_transport_only_after_bounded_model_resolution() -> None:
    source = _function_source(
        "api/endpoints/wizard.py",
        "test_system_prompt_stream",
    )
    assert "web_stream_worker_client.stream" in source
    assert "WIZARD_PROMPT_STREAM" in source
    assert "run_sync_in_executor" in source
    assert "simple_chat_service" not in source


def test_deep_research_stream_does_not_construct_or_consume_gemini_client() -> None:
    source = _function_source(
        "api/endpoints/deep_research.py",
        "stream_deep_research_result",
    )
    assert "web_stream_worker_client.stream" in source
    assert "DEEP_RESEARCH_STREAM" in source
    for forbidden in (
        "GeminiInteractionClient",
        "stream_interaction_result",
        "json.loads",
        "json.dumps",
    ):
        assert forbidden not in source


def test_subtask_subscription_does_not_touch_redis_or_project_messages() -> None:
    source = _function_source(
        "api/endpoints/subtasks.py",
        "subscribe_group_stream",
    )
    assert "web_stream_worker_client.stream" in source
    assert "SUBTASK_SUBSCRIPTION_STREAM" in source
    assert "run_sync_in_executor" in source
    for forbidden in (
        "session_manager",
        "subscribe_streaming_channel",
        "get_streaming_content",
        "pubsub",
        "run_payload_codec",
    ):
        assert forbidden not in source


def test_runtime_cursor_does_not_read_stream_content_in_web() -> None:
    source = _function_source(
        "api/endpoints/adapter/tasks.py",
        "get_task_runtime_check",
    )
    assert "TASK_RUNTIME_ACTIVE_STREAM_EXECUTE" in source
    assert "_execute_worker_operation" in source
    for forbidden in (
        "session_manager",
        "get_streaming_content",
        "get_streaming_content_length",
        "get_task_streaming_status",
    ):
        assert forbidden not in source


def test_all_stream_business_logic_is_owned_by_worker_service() -> None:
    source = (APP_ROOT / "services/execution/web_stream_execution.py").read_text(
        encoding="utf-8"
    )
    for required in (
        "stateless_runtime_service.stream_response",
        "prompt_draft_service.generate_prompt_draft_stream",
        "simple_chat_service.chat_stream",
        "GeminiInteractionClient",
        "session_manager.subscribe_streaming_channel",
        "pubsub.get_message",
        "stateless_runtime_service.complete_text",
        "prompt_draft_service.generate_prompt_draft_result",
        "simple_chat_service.chat_completion",
        "client.create_interaction",
        "client.get_interaction_status",
    ):
        assert required in source


def test_all_web_streams_share_connection_and_byte_admission() -> None:
    source = (APP_ROOT / "services/execution/web_stream_client.py").read_text(
        encoding="utf-8"
    )
    assert "web_stream_rpc_admission" in source
    assert "web_stream_relay_byte_admission" in source
    assert "yield data" in source
    assert "await lease.release()" in source

    server_source = (APP_ROOT / "stream_worker.py").read_text(encoding="utf-8")
    assert 'frame.get("type") == "web_stream"' in server_source
    assert 'frame.get("type") == "web_execute"' in server_source
    assert "web_stream_projector=web_stream_execution_service" in server_source


def test_nonstream_model_lifecycles_are_not_web_owned() -> None:
    checks = (
        (
            "api/endpoints/adapter/tasks.py",
            "generate_task_prompt_draft",
            "PROMPT_DRAFT_EXECUTE",
            ("generate_prompt_draft", "asyncio.run"),
        ),
        (
            "api/endpoints/wizard.py",
            "_execute_wizard_model",
            "WIZARD_PROMPT_EXECUTE",
            ("simple_chat_service", "chat_completion"),
        ),
        (
            "api/endpoints/deep_research.py",
            "create_deep_research",
            "DEEP_RESEARCH_CREATE_EXECUTE",
            ("GeminiInteractionClient", "create_interaction"),
        ),
        (
            "api/endpoints/deep_research.py",
            "get_deep_research_status",
            "DEEP_RESEARCH_STATUS_EXECUTE",
            ("GeminiInteractionClient", "get_interaction_status"),
        ),
    )
    for path, function, operation, forbidden in checks:
        source = _function_source(path, function)
        assert "web_stream_worker_client.execute" in source or (
            function in {"create_deep_research", "get_deep_research_status"}
            and "_execute_deep_research" in source
        )
        assert operation in source
        for value in forbidden:
            assert value not in source
