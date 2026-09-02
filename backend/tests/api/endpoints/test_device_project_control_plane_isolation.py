# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import ast
import asyncio
import threading
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.bounded_executor import BoundedExecutorOverloaded

ENDPOINT_FILES = (
    "app/api/endpoints/devices.py",
    "app/api/endpoints/projects.py",
    "app/api/endpoints/internal/workspace_archives.py",
    "app/api/endpoints/subtasks.py",
    "app/api/endpoints/runtime_profiles.py",
    "app/api/endpoints/local_executor.py",
    "app/api/endpoints/device_chat_tasks.py",
)


def _references_sync_session(annotation: ast.expr | None) -> bool:
    if annotation is None:
        return False
    return any(
        (isinstance(node, ast.Name) and node.id == "Session")
        or (isinstance(node, ast.Attribute) and node.attr == "Session")
        for node in ast.walk(annotation)
    )


def _depends_on_sync_db(default: ast.expr) -> bool:
    return any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "Depends"
        and any(isinstance(arg, ast.Name) and arg.id == "get_db" for arg in node.args)
        for node in ast.walk(default)
    )


def test_async_control_plane_endpoints_do_not_accept_sync_sessions() -> None:
    violations: list[str] = []
    for relative_path in ENDPOINT_FILES:
        source = Path(relative_path).read_text(encoding="utf-8")
        tree = ast.parse(source, filename=relative_path)
        for function in ast.walk(tree):
            if not isinstance(function, ast.AsyncFunctionDef):
                continue
            arguments = (
                function.args.posonlyargs
                + function.args.args
                + function.args.kwonlyargs
            )
            for argument in arguments:
                if argument.arg == "db" or _references_sync_session(
                    argument.annotation
                ):
                    violations.append(
                        f"{relative_path}:{function.lineno}:{function.name}"
                    )
            defaults = function.args.defaults + function.args.kw_defaults
            if any(
                default is not None and _depends_on_sync_db(default)
                for default in defaults
            ):
                violations.append(
                    f"{relative_path}:{function.lineno}:{function.name}:Depends(get_db)"
                )
    assert violations == []


async def _wait_for_thread(event: threading.Event) -> None:
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.005)
    raise TimeoutError("database worker did not start")


@pytest.mark.asyncio
async def test_slow_runtime_profile_db_phase_keeps_loop_schedulable(
    monkeypatch,
) -> None:
    from app.api.endpoints import runtime_profiles

    started = threading.Event()
    release = threading.Event()

    def slow_load(_user_id: int, _devices: list[dict]):
        started.set()
        release.wait(timeout=5)
        return []

    monkeypatch.setattr(runtime_profiles, "_load_runtime_profiles", slow_load)
    monkeypatch.setattr(
        runtime_profiles.device_service,
        "get_all_devices_nonblocking",
        AsyncMock(return_value=[]),
    )
    task = asyncio.create_task(
        runtime_profiles.list_runtime_profiles(
            current_user=runtime_profiles._RuntimeProfileUser(id=7)
        )
    )
    await _wait_for_thread(started)

    progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(progressed.set)
    await asyncio.wait_for(progressed.wait(), timeout=0.2)
    assert not task.done()

    release.set()
    assert await task == []


@pytest.mark.asyncio
async def test_cancelled_runtime_profile_request_still_closes_worker_session(
    monkeypatch,
) -> None:
    from app.api.endpoints import runtime_profiles

    started = threading.Event()
    release = threading.Event()
    closed = threading.Event()

    @contextmanager
    def worker_session():
        try:
            yield object()
        finally:
            closed.set()

    def slow_defaults(_db, _user_id: int, _devices: list[dict]) -> None:
        started.set()
        release.wait(timeout=5)

    monkeypatch.setattr(
        "app.services.chat.storage.db.get_db_session",
        worker_session,
    )
    monkeypatch.setattr(
        runtime_profiles.runtime_profile_service,
        "ensure_device_defaults",
        slow_defaults,
    )
    monkeypatch.setattr(
        runtime_profiles.runtime_profile_service,
        "list",
        MagicMock(return_value=[]),
    )
    monkeypatch.setattr(
        runtime_profiles.device_service,
        "get_all_devices_nonblocking",
        AsyncMock(return_value=[]),
    )
    task = asyncio.create_task(
        runtime_profiles.list_runtime_profiles(
            current_user=runtime_profiles._RuntimeProfileUser(id=7)
        )
    )
    await _wait_for_thread(started)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not closed.is_set()

    release.set()
    await _wait_for_thread(closed)


@pytest.mark.asyncio
async def test_db_executor_overload_prevents_runtime_profile_mutation(
    monkeypatch,
) -> None:
    from app.api.endpoints import runtime_profiles

    load = MagicMock()

    async def reject(*_args, **_kwargs):
        raise BoundedExecutorOverloaded("injected capacity exhaustion")

    monkeypatch.setattr(
        "app.services.chat.storage.db.run_sync_in_executor",
        reject,
    )
    monkeypatch.setattr(runtime_profiles, "_load_runtime_profiles", load)
    monkeypatch.setattr(
        runtime_profiles.device_service,
        "get_all_devices_nonblocking",
        AsyncMock(return_value=[]),
    )

    with pytest.raises(BoundedExecutorOverloaded):
        await runtime_profiles.list_runtime_profiles(
            current_user=runtime_profiles._RuntimeProfileUser(id=9)
        )
    load.assert_not_called()
