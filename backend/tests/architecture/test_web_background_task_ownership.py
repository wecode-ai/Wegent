# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Static ownership rules for work detached from Web request lifetimes."""

from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"
REPOSITORY_ROOT = APP_ROOT.parent.parent

_EXPLICIT_WEB_REACHABLE_FILES = (
    "core/async_utils.py",
    "core/distributed_lock.py",
    "core/events.py",
    "core/socketio.py",
    "core/web_background_tasks.py",
    "repository/github_provider.py",
    "repository/gitea_provider.py",
    "repository/gitee_provider.py",
    "repository/gitlab_provider.py",
    "services/adapters/task_kinds/operations.py",
    "services/background_chat_executor.py",
    "services/chat/pipeline_advance.py",
    "services/chat/preprocessing/contexts.py",
    "services/chat/storage/task_manager.py",
    "services/chat/webpage_ws_chat_emitter.py",
    "services/chat/webpage_ws_extended_emitter.py",
    "services/correction_service.py",
    "services/device/admin_device_batch.py",
    "services/device/version_service.py",
    "services/device_chat_task_service.py",
    "services/execution/emitters/base.py",
    "services/execution/stream_client.py",
    "services/inbox/direct_agent_handler.py",
    "services/knowledge/artifact_task_launcher.py",
    "services/loop_item_events.py",
    "services/loop_item_executions/wake.py",
    "services/loop_items/assignment_notification.py",
    "services/message_forwarding_service.py",
    "services/openapi/chat_session.py",
    "services/project_automation_managed_execution.py",
    "services/subscription/execution.py",
    "services/tables/providers/dingtalk/user_mapping.py",
)
_REQUEST_OWNED_TASK_ALLOWLIST = {
    (
        "api/endpoints/adapter/attachments.py",
        "_stream_stored_attachment",
        "asyncio.create_task",
    ),
    (
        "core/async_utils.py",
        "run_in_event_loop",
        "asyncio.run_coroutine_threadsafe",
    ),
    (
        "core/distributed_lock.py",
        "acquire_watchdog_context_async",
        "asyncio.create_task",
    ),
    (
        "core/socketio.py",
        "_queue_local_send",
        "asyncio.create_task",
    ),
    (
        "core/web_background_tasks.py",
        "submit_threadsafe",
        "asyncio.run_coroutine_threadsafe",
    ),
    (
        "core/web_background_tasks.py",
        "_admit",
        "asyncio.create_task",
    ),
    (
        "services/background_chat_executor.py",
        "execute",
        "asyncio.create_task",
    ),
    (
        "services/background_chat_executor.py",
        "_dispatch_and_collect",
        "asyncio.create_task",
    ),
    (
        "services/execution/emitters/base.py",
        "emit",
        "asyncio.create_task",
    ),
    (
        "services/execution/stream_client.py",
        "_dispatch_admitted",
        "asyncio.create_task",
    ),
    (
        "services/inbox/direct_agent_handler.py",
        "_dispatch_ai_execution",
        "asyncio.create_task",
    ),
    (
        "services/project_automation_managed_execution.py",
        "execute",
        "asyncio.create_task",
    ),
}


def _dotted_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def _import_aliases(tree: ast.Module) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for imported in node.names:
                aliases[imported.asname or imported.name.split(".")[0]] = imported.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for imported in node.names:
                aliases[imported.asname or imported.name] = (
                    f"{node.module}.{imported.name}"
                )
    return aliases


def _resolve_call(call: ast.Call, aliases: dict[str, str]) -> str:
    dotted = _dotted_name(call.func)
    root, separator, suffix = dotted.partition(".")
    resolved_root = aliases.get(root, root)
    return f"{resolved_root}.{suffix}" if separator else resolved_root


def _enclosing_function(
    node: ast.AST,
    parents: dict[ast.AST, ast.AST],
) -> str:
    current = node
    while current in parents:
        current = parents[current]
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return current.name
    return "<module>"


def _detached_scheduler_name(call: ast.Call, aliases: dict[str, str]) -> str | None:
    resolved = _resolve_call(call, aliases)
    if resolved in {
        "asyncio.create_task",
        "asyncio.run_coroutine_threadsafe",
    }:
        return resolved
    if not isinstance(call.func, ast.Attribute):
        return None
    owner = _dotted_name(call.func.value).rsplit(".", 1)[-1]
    if call.func.attr == "create_task" and owner in {
        "event_loop",
        "loop",
        "main_loop",
        "_main_event_loop",
    }:
        return f"{owner}.create_task"
    if call.func.attr == "run_coroutine_threadsafe":
        return resolved
    return None


def _web_reachable_paths() -> list[Path]:
    paths = [
        *(APP_ROOT / "api" / "endpoints").rglob("*.py"),
        *(APP_ROOT / "api" / "ws").rglob("*.py"),
        *(APP_ROOT / relative for relative in _EXPLICIT_WEB_REACHABLE_FILES),
    ]
    return sorted(set(paths))


def test_web_reachable_detached_work_uses_the_bounded_owner() -> None:
    violations: list[str] = []
    for path in _web_reachable_paths():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        aliases = _import_aliases(tree)
        parents = {
            child: parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        relative = path.relative_to(APP_ROOT).as_posix()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            scheduler = _detached_scheduler_name(node, aliases)
            if scheduler is None:
                continue
            function = _enclosing_function(node, parents)
            if (relative, function, scheduler) in _REQUEST_OWNED_TASK_ALLOWLIST:
                continue
            violations.append(f"{relative}:{node.lineno} {function} -> {scheduler}")

    assert violations == []


def test_request_owned_attachment_loader_is_shielded_until_lease_release() -> None:
    source = (APP_ROOT / "api/endpoints/adapter/attachments.py").read_text(
        encoding="utf-8"
    )

    assert "load_task = asyncio.create_task(" in source
    assert "await asyncio.shield(load_task)" in source
    assert "load_task.add_done_callback(lambda _: lease.release())" in source


def test_web_background_owner_is_started_and_joined_by_lifespan() -> None:
    source = (APP_ROOT / "main.py").read_text(encoding="utf-8")

    start = source.index("web_background_task_manager.start()")
    shutdown = source.index("await web_background_task_manager.shutdown()")
    application_shutdown = source.index("await shutdown_manager.initiate_shutdown()")

    assert start < shutdown < application_shutdown


def test_cross_loop_bridge_is_joined_and_has_no_fallback_scheduler() -> None:
    source = (APP_ROOT / "core/async_utils.py").read_text(encoding="utf-8")

    assert "return await asyncio.wrap_future(future)" in source
    assert "def schedule_async_task(" not in source
    assert "daemon=True" not in source
    assert "threading.Thread(" not in source
    assert "Failed to schedule" not in source


def test_event_bus_uses_global_owner_and_joins_local_handlers() -> None:
    source = (APP_ROOT / "core/events.py").read_text(encoding="utf-8")

    assert "web_background_task_manager.submit_from_sync(" in source
    assert "await asyncio.gather(" in source
    assert "run_coroutine_threadsafe" not in source
    assert "asyncio.create_task(" not in source
    assert "return_exceptions=True" not in source


def test_transitive_web_tasks_are_locally_joined_or_lifecycle_owned() -> None:
    distributed_lock_source = (APP_ROOT / "core/distributed_lock.py").read_text(
        encoding="utf-8"
    )
    socketio_source = (APP_ROOT / "core/socketio.py").read_text(encoding="utf-8")
    emitter_source = (APP_ROOT / "services/execution/emitters/base.py").read_text(
        encoding="utf-8"
    )
    stream_client_source = (APP_ROOT / "services/execution/stream_client.py").read_text(
        encoding="utf-8"
    )

    assert "watchdog_task.cancel()" in distributed_lock_source
    assert "await watchdog_task" in distributed_lock_source
    assert "await asyncio.gather(*pending_sends)" in socketio_source
    assert "await asyncio.gather(*pending_sends, return_exceptions=True)" in (
        socketio_source
    )
    assert "await asyncio.wait(" in emitter_source
    assert "await asyncio.gather(put_task, return_exceptions=True)" in emitter_source
    assert "await asyncio.gather(close_task, return_exceptions=True)" in emitter_source
    assert "receive_error = await receive_task" in stream_client_source
    assert "await drain_task" in stream_client_source
    assert "await asyncio.gather(*pending_tasks, return_exceptions=True)" in (
        stream_client_source
    )

    joined_dispatch_counts = {
        "services/background_chat_executor.py": 2,
        "services/inbox/direct_agent_handler.py": 1,
        "services/project_automation_managed_execution.py": 1,
    }
    for relative, minimum_count in joined_dispatch_counts.items():
        source = (APP_ROOT / relative).read_text(encoding="utf-8")
        assert source.count("await dispatch_task") >= minimum_count


def test_attachment_binary_data_never_returns_to_web_preprocessing() -> None:
    contexts_path = APP_ROOT / "services/chat/preprocessing/contexts.py"
    source = contexts_path.read_text(encoding="utf-8")

    for forbidden in (
        "get_attachment_binary_data",
        "run_coroutine_threadsafe",
        "sandbox_file_syncer",
        "sync_attachment_to_sandbox",
    ):
        assert forbidden not in source
    assert not (APP_ROOT / "services/sandbox_file_syncer.py").exists()


def test_obsolete_cross_loop_websocket_emitters_are_deleted() -> None:
    assert not (APP_ROOT / "services/chat/ws_emitter.py").exists()
    assert not (APP_ROOT / "services/chat/webpage_websocket_chat_emitter.py").exists()


def test_executor_downloads_attachment_ids_from_execution_request() -> None:
    trigger_source = (APP_ROOT / "services/chat/trigger/unified.py").read_text(
        encoding="utf-8"
    )
    processor_source = (
        REPOSITORY_ROOT / "executor_manager/tasks/task_processor.py"
    ).read_text(encoding="utf-8")
    executor_source = (
        REPOSITORY_ROOT / "executor/src/attachments/handler.rs"
    ).read_text(encoding="utf-8")

    assert "request.attachments = [" in trigger_source
    assert "_build_executor_attachment_payload(context)" in trigger_source
    assert 'get_metadata_field(task_dict, "attachments", [])' in processor_source
    assert "downloader.download_all(&config, &task.attachments)" in executor_source


def test_detached_ai_execution_crosses_bounded_worker_boundaries() -> None:
    trigger_source = (APP_ROOT / "services/chat/trigger/unified.py").read_text(
        encoding="utf-8"
    )
    dispatcher_source = (APP_ROOT / "services/execution/dispatcher.py").read_text(
        encoding="utf-8"
    )
    stream_client_source = (APP_ROOT / "services/execution/stream_client.py").read_text(
        encoding="utf-8"
    )

    assert "return await run_sync_in_executor(build)" in trigger_source
    assert "await execution_dispatcher.dispatch(" in trigger_source
    assert "await stream_execution_client.dispatch(" in dispatcher_source
    assert "STREAM_WORKER_MAX_CONNECTIONS = 256" in stream_client_source
    assert "_EVENT_RELAY_CAPACITY = 64" in stream_client_source
    assert "_EVENT_RELAY_MAX_BYTES = 64 * 1024 * 1024" in stream_client_source
    assert "asyncio.Queue(" in stream_client_source
    assert "maxsize=self._event_relay_capacity" in stream_client_source


def test_detached_sync_io_uses_finite_executors_and_network_timeouts() -> None:
    blocking_work_source = (APP_ROOT / "core/blocking_work.py").read_text(
        encoding="utf-8"
    )
    version_checker_source = (
        APP_ROOT / "services/device/version_checker.py"
    ).read_text(encoding="utf-8")
    memory_client_source = (APP_ROOT / "services/memory/client.py").read_text(
        encoding="utf-8"
    )
    shell_source = (APP_ROOT / "api/endpoints/adapter/shells.py").read_text(
        encoding="utf-8"
    )

    assert "_repository_io_executor = BoundedExecutor(" in blocking_work_source
    assert "_device_io_executor = BoundedExecutor(" in blocking_work_source
    assert "max_in_flight=8" in blocking_work_source
    assert "max_in_flight=4" in blocking_work_source
    assert "return await run_device_io(self._fetch_latest_version)" in (
        version_checker_source
    )
    assert "AsyncSessionManager(timeout=request_timeout)" in memory_client_source
    assert "httpx.AsyncClient(timeout=10.0)" in shell_source

    for provider in ("github", "gitea", "gitee", "gitlab"):
        source = (APP_ROOT / f"repository/{provider}_provider.py").read_text(
            encoding="utf-8"
        )
        assert "async def _fetch_all_repositories_async(" in source
        assert "await run_repository_io(" in source
        assert "timeout=settings.REPOSITORY_READ_TIMEOUT_SECONDS" in source


def test_socket_notifications_have_finite_connection_queue_and_payload_limits() -> None:
    socketio_source = (APP_ROOT / "core/socketio.py").read_text(encoding="utf-8")

    assert "SOCKETIO_CLIENT_QUEUE_MAX_PACKETS = 8" in socketio_source
    assert "SOCKETIO_REDIS_MESSAGE_MAX_BYTES = 2 * 1024 * 1024" in socketio_source
    assert "SOCKETIO_MAX_CONNECTIONS = settings.WEB_MAX_WEBSOCKET_CONNECTIONS" in (
        socketio_source
    )
    assert "asyncio.Queue(maxsize=SOCKETIO_CLIENT_QUEUE_MAX_PACKETS)" in (
        socketio_source
    )
    assert "len(pending) < SOCKETIO_LOCAL_SEND_CONCURRENCY" in socketio_source
