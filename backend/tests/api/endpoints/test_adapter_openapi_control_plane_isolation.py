# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import ast
import asyncio
import threading
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core import security
from app.core.bounded_executor import BoundedExecutorOverloaded

TARGETS = {
    "app/api/endpoints/adapter/chat.py": {"correct_response"},
    "app/api/endpoints/adapter/subscriptions.py": {"trigger_subscription_webhook"},
    "app/api/endpoints/adapter/task_members.py": {
        "add_task_member",
        "join_by_invite",
    },
    "app/api/endpoints/adapter/tasks.py": {
        "get_task_runtime_check",
        "generate_task_prompt_draft_stream",
        "cancel_task",
    },
    "app/api/endpoints/openapi_responses.py": {
        "create_response",
        "get_response",
        "cancel_response",
        "delete_response",
    },
    "app/api/endpoints/cloud_projects.py": {"assign_loop_item"},
    "app/api/endpoints/users.py": {"import_user_runtime_auth_json_from_device"},
}


def _references_sync_session(annotation: ast.expr | None) -> bool:
    return annotation is not None and any(
        isinstance(node, ast.Name) and node.id == "Session"
        for node in ast.walk(annotation)
    )


def _references_async_session(annotation: ast.expr | None) -> bool:
    return annotation is not None and any(
        isinstance(node, ast.Name) and node.id == "AsyncSession"
        for node in ast.walk(annotation)
    )


def _dependency_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _depends_on_live_session(
    default: ast.expr | None,
    *,
    forbid_orm_user: bool,
) -> bool:
    forbidden_dependencies = {"get_db"}
    if forbid_orm_user:
        forbidden_dependencies.add("get_current_user")
    return default is not None and any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "Depends"
        and any(_dependency_name(arg) in forbidden_dependencies for arg in node.args)
        for node in ast.walk(default)
    )


def test_target_async_routes_never_accept_a_sync_session() -> None:
    violations: list[str] = []
    found: dict[str, set[str]] = {path: set() for path in TARGETS}
    for path, target_names in TARGETS.items():
        tree = ast.parse(Path(path).read_text(encoding="utf-8"), filename=path)
        for function in ast.walk(tree):
            if not isinstance(function, ast.AsyncFunctionDef):
                continue
            is_target = function.name in target_names
            if is_target:
                found[path].add(function.name)
            arguments = (
                function.args.posonlyargs
                + function.args.args
                + function.args.kwonlyargs
            )
            if any(
                (
                    argument.arg == "db"
                    and not _references_async_session(argument.annotation)
                )
                or _references_sync_session(argument.annotation)
                for argument in arguments
            ):
                violations.append(f"{path}:{function.lineno}:{function.name}:Session")
            defaults = function.args.defaults + function.args.kw_defaults
            if any(
                _depends_on_live_session(default, forbid_orm_user=is_target)
                for default in defaults
            ):
                violations.append(
                    f"{path}:{function.lineno}:{function.name}:live-session-dependency"
                )

    assert found == TARGETS
    assert violations == []


async def _wait_for_thread(event: threading.Event) -> None:
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.005)
    raise TimeoutError("worker did not start")


@pytest.mark.asyncio
async def test_detached_auth_runs_in_db_worker_and_closes_before_return(
    monkeypatch,
) -> None:
    session_closed = threading.Event()
    worker_name: str | None = None

    @contextmanager
    def worker_session():
        nonlocal worker_name
        worker_name = threading.current_thread().name
        try:
            yield object()
        finally:
            session_closed.set()

    monkeypatch.setattr("app.db.session.SessionLocal", worker_session)
    monkeypatch.setattr(
        security,
        "get_current_user",
        lambda *, token, db: SimpleNamespace(id=41, user_name="worker-user"),
    )

    user = await security.get_detached_current_user(token="bearer-token")

    assert user == security.DetachedUser(id=41, user_name="worker-user")
    assert worker_name is not None and worker_name.startswith("wegent-db")
    assert session_closed.is_set()


@pytest.mark.asyncio
async def test_detached_flexible_auth_closes_worker_session(monkeypatch) -> None:
    session_closed = threading.Event()

    @contextmanager
    def worker_session():
        try:
            yield object()
        finally:
            session_closed.set()

    monkeypatch.setattr("app.db.session.SessionLocal", worker_session)
    monkeypatch.setattr(
        security,
        "get_auth_context",
        lambda **_kwargs: security.AuthContext(
            user=SimpleNamespace(id=42, user_name="api-user"),
            api_key_name="personal-key",
        ),
    )

    context = await security.get_detached_auth_context(
        api_key="wg-key",
        wegent_username=None,
        authorization="",
    )

    assert context == security.DetachedAuthContext(
        user=security.DetachedUser(id=42, user_name="api-user"),
        api_key_name="personal-key",
    )
    assert session_closed.is_set()


@pytest.mark.asyncio
async def test_slow_task_runtime_db_keeps_the_loop_schedulable(monkeypatch) -> None:
    from app.api.endpoints.adapter import tasks

    started = threading.Event()
    release = threading.Event()

    def slow_snapshot(_task_id: int, _user_id: int):
        started.set()
        release.wait(timeout=5)
        return tasks._TaskRuntimeSnapshot(status="RUNNING", updated_at=None)

    monkeypatch.setattr(tasks, "_load_task_runtime_snapshot_sync", slow_snapshot)
    monkeypatch.setattr(
        tasks.web_stream_worker_client,
        "execute",
        AsyncMock(return_value={"active_stream": None}),
    )
    pending = asyncio.create_task(
        tasks.get_task_runtime_check(
            task_id=17,
            current_user=security.DetachedUser(id=9, user_name="user-9"),
        )
    )
    await _wait_for_thread(started)

    progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(progressed.set)
    await asyncio.wait_for(progressed.wait(), timeout=0.2)
    assert not pending.done()

    release.set()
    response = await pending
    assert response.task_status == "RUNNING"


@pytest.mark.asyncio
async def test_cancelled_runtime_import_eventually_closes_its_worker_session(
    monkeypatch,
) -> None:
    from app.services import user_runtime_config as module

    started = threading.Event()
    release = threading.Event()
    closed = threading.Event()

    @contextmanager
    def worker_session():
        try:
            yield object()
        finally:
            closed.set()

    async def device_command(**kwargs):
        assert kwargs["db"] is None
        return {
            "success": True,
            "stdout": {"content": '{"token":"value"}'},
        }

    def slow_save(_db, **_kwargs):
        started.set()
        release.wait(timeout=5)
        return {"configured": True}

    monkeypatch.setattr(module, "execute_configured_device_command", device_command)
    monkeypatch.setattr(
        "app.services.chat.storage.db.get_db_session",
        worker_session,
    )
    monkeypatch.setattr(module.user_runtime_config_service, "save_auth_json", slow_save)

    pending = asyncio.create_task(
        module.user_runtime_config_service.import_auth_json_from_device(
            user_id=7,
            runtime="codex",
            device_id="device-7",
        )
    )
    await _wait_for_thread(started)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert not closed.is_set()

    release.set()
    await _wait_for_thread(closed)


@pytest.mark.asyncio
async def test_db_overload_prevents_member_mutation_and_notification(
    monkeypatch,
) -> None:
    from app.api.endpoints.adapter import task_members
    from app.schemas.task_member import AddMemberRequest

    mutation = MagicMock()
    notification = AsyncMock()

    async def reject(*_args, **_kwargs):
        raise BoundedExecutorOverloaded("injected capacity exhaustion")

    monkeypatch.setattr("app.services.chat.storage.db.run_sync_in_executor", reject)
    monkeypatch.setattr(task_members, "_add_task_member_sync", mutation)
    monkeypatch.setattr(task_members, "_emit_task_invited", notification)

    with pytest.raises(BoundedExecutorOverloaded):
        await task_members.add_task_member(
            task_id=11,
            request=AddMemberRequest(user_id=12),
            current_user=security.DetachedUser(id=10, user_name="user-10"),
        )
    mutation.assert_not_called()
    notification.assert_not_awaited()


@pytest.mark.asyncio
async def test_webhook_db_overload_does_not_dispatch_to_the_broker(monkeypatch) -> None:
    from app.services.subscription import subscription_service

    dispatch = MagicMock()

    async def reject(*_args, **_kwargs):
        raise BoundedExecutorOverloaded("injected capacity exhaustion")

    monkeypatch.setattr("app.services.chat.storage.db.run_sync_in_executor", reject)
    monkeypatch.setattr(
        subscription_service,
        "_dispatch_webhook_execution_sync",
        dispatch,
    )

    with pytest.raises(BoundedExecutorOverloaded):
        await subscription_service.trigger_subscription_webhook_nonblocking(
            webhook_token="token",
            body=b"{}",
            signature=None,
        )
    dispatch.assert_not_called()


@pytest.mark.asyncio
async def test_task_cancel_schedules_runtime_call_only_after_db_plan(
    monkeypatch,
) -> None:
    from app.services.adapters.task_kinds import operations, task_kinds_service

    events: list[str] = []
    scheduled: list[tuple[object, object]] = []

    async def db_run(function, *args):
        assert function == task_kinds_service._prepare_cancel_task_from_store
        events.append("db")
        return operations._CancelTaskPlan(
            response={"message": "accepted", "status": "CANCELLED"},
            background_kind="executor",
            background_arg=73,
        )

    def schedule(function, argument):
        events.append("schedule")
        scheduled.append((function, argument))

    monkeypatch.setattr("app.services.chat.storage.db.run_sync_in_executor", db_run)

    response = await task_kinds_service.cancel_task_nonblocking(
        task_id=73,
        user_id=8,
        background_task_runner=schedule,
    )

    assert response == {"message": "accepted", "status": "CANCELLED"}
    assert events == ["db", "schedule"]
    assert scheduled == [(task_kinds_service._call_executor_cancel, 73)]


@pytest.mark.asyncio
async def test_correction_closes_db_phase_before_model_and_save(monkeypatch) -> None:
    from app.api.endpoints.adapter import chat
    from app.services.chat.correction import CorrectionPreparation

    events: list[str] = []
    llm_result = {
        "scores": {"accuracy": 10},
        "corrections": [],
        "summary": "ok",
        "improved_answer": "answer",
        "is_correct": True,
    }

    async def prepare(**_kwargs):
        events.append("prepare-db")
        return CorrectionPreparation(
            subtask_id=31,
            message_id=7,
            existing_correction=None,
            model_config={"model_id": "reviewer"},
            history=[{"role": "user", "content": "question"}],
        )

    async def evaluate(**_kwargs):
        events.append("model")
        return llm_result

    async def save(**_kwargs):
        events.append("save-db")

    class Emitter:
        async def emit_correction_start(self, **_kwargs):
            events.append("start")

        async def emit_correction_done(self, **_kwargs):
            events.append("done")

        async def emit_correction_error(self, **_kwargs):
            events.append("error")

    monkeypatch.setattr(chat, "prepare_correction", prepare)
    monkeypatch.setattr(chat, "evaluate_correction", evaluate)
    monkeypatch.setattr(chat, "save_correction", save)
    monkeypatch.setattr(
        "app.services.chat.webpage_ws_chat_emitter.get_extended_emitter",
        lambda: Emitter(),
    )

    response = await chat.correct_response(
        request=chat.CorrectionRequest(
            task_id=5,
            message_id=7,
            original_question="question",
            original_answer="answer",
            correction_model_id="reviewer",
        ),
        current_user=security.DetachedUser(id=3, user_name="review-user"),
    )

    assert response["message_id"] == 7
    assert events == ["prepare-db", "start", "model", "save-db", "done"]


@pytest.mark.asyncio
async def test_internal_team_assignment_orders_db_dispatch_and_finalize(
    monkeypatch,
) -> None:
    from app.api.endpoints import cloud_projects
    from app.schemas.project_chat import LoopItemAssign

    events: list[str] = []
    expected = object()

    async def db_run(function, *args):
        events.append(function.__name__)
        if function is cloud_projects._is_external_loop_item_sync:
            return False
        if function is cloud_projects._finalize_internal_loop_item_sync:
            return expected
        return None

    async def dispatch(*, item_id: str):
        assert item_id == "item-1"
        events.append("dispatch")

    monkeypatch.setattr("app.services.chat.storage.db.run_sync_in_executor", db_run)
    monkeypatch.setattr(
        "app.services.board_team_execution.dispatch_board_team_assignment_nonblocking",
        dispatch,
    )
    background_tasks = cloud_projects.BackgroundTasks()

    result = await cloud_projects.assign_loop_item(
        project_id=9,
        item_id="item-1",
        values=LoopItemAssign(
            version=1,
            assignee_type="agent",
            assignee_id="team-1",
        ),
        background_tasks=background_tasks,
        current_user=security.DetachedUser(id=4, user_name="owner"),
    )

    assert result is expected
    assert events == [
        "_is_external_loop_item_sync",
        "_assign_internal_loop_item_sync",
        "dispatch",
        "_finalize_internal_loop_item_sync",
    ]
    assert len(background_tasks.tasks) == 1


@pytest.mark.asyncio
async def test_external_team_assignment_uses_repository_capacity(monkeypatch) -> None:
    from app.api.endpoints import cloud_projects
    from app.schemas.project_chat import LoopItemAssign

    events: list[str] = []
    expected = object()

    async def db_run(function, *args):
        assert function is cloud_projects._is_external_loop_item_sync
        events.append("detect-db")
        return True

    async def repository_run(function, *args):
        events.append(function.__name__)
        if function is cloud_projects._get_external_loop_item_sync:
            return expected
        return object()

    async def dispatch(*, item_id: str):
        assert item_id == "external:item-1"
        events.append("dispatch")

    monkeypatch.setattr("app.services.chat.storage.db.run_sync_in_executor", db_run)
    monkeypatch.setattr("app.core.blocking_work.run_repository_io", repository_run)
    monkeypatch.setattr(
        "app.services.board_team_execution.dispatch_board_team_assignment_nonblocking",
        dispatch,
    )
    background_tasks = cloud_projects.BackgroundTasks()

    result = await cloud_projects.assign_loop_item(
        project_id=9,
        item_id="external:item-1",
        values=LoopItemAssign(
            version=2,
            assignee_type="agent",
            assignee_id="team-1",
        ),
        background_tasks=background_tasks,
        current_user=security.DetachedUser(id=4, user_name="owner"),
    )

    assert result is expected
    assert events == [
        "detect-db",
        "_assign_external_loop_item_sync",
        "dispatch",
        "_get_external_loop_item_sync",
    ]
    assert len(background_tasks.tasks) == 1
