"""The private Rust adapter uses the established Python answer lifecycle."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.services.execution import web_answer_runtime as runtime


def operation(**changes):
    return runtime.WebAnswerOperation(
        **dict(
            action="start",
            task_id=9,
            answer_id=12,
            actor_id=7,
            user_subtask_id=11,
            message="question",
            **changes,
        )
    )


@pytest.fixture
def context(monkeypatch):
    db = MagicMock()
    factory = MagicMock()
    factory.return_value.__enter__.return_value = db
    monkeypatch.setattr(runtime, "SessionLocal", factory)
    task = SimpleNamespace(id=9, client_origin="frontend", json={"spec": {}})
    answer = Subtask(
        id=12,
        task_id=9,
        team_id=3,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.PENDING,
    )
    user_turn = SimpleNamespace(task_id=9, role=SubtaskRole.USER, id=11)
    monkeypatch.setattr(
        runtime.subtask_store,
        "get_basic_by_id",
        lambda db, *, subtask_id: answer if subtask_id == 12 else user_turn,
    )
    monkeypatch.setattr(runtime.task_access_store, "get_task", lambda *a, **k: task)
    monkeypatch.setattr(runtime.task_access_store, "is_member", lambda *a, **k: True)
    monkeypatch.setattr(runtime, "_selected_shell", lambda *a: "Chat")
    monkeypatch.setattr(runtime, "_has_native_knowledge", lambda *a: True)
    db.get.side_effect = lambda model, key: SimpleNamespace(id=key)
    monkeypatch.setattr(
        runtime.subtask_store, "update_fields_if_attempt", lambda *a, **k: True
    )
    monkeypatch.setattr(
        "app.api.ws.chat_namespace._detach_retry_dispatch_objects", lambda *a: None
    )
    return db, task, answer


def test_start_captures_server_identity_before_async_preparation(context):
    db, _, answer = context
    prepared = runtime._prepare(operation())
    assert prepared["assistant_subtask"] is answer
    assert len(answer.answer_generation_id) == 32
    assert prepared["payload"].message == "question"
    assert prepared["user"].id == 7
    assert prepared["user_subtask_id"] == 11
    db.commit.assert_called_once()


def test_disabled_deep_thinking_reaches_the_existing_trigger(context):
    prepared = runtime._prepare(operation(options={"enable_deep_thinking": False}))
    assert prepared["enable_deep_thinking"] is False


def test_turn_without_native_knowledge_keeps_existing_runtime(context, monkeypatch):
    monkeypatch.setattr(runtime, "_has_native_knowledge", lambda *a: False)
    assert runtime._prepare(operation()) is None
    context[0].commit.assert_not_called()


@pytest.mark.parametrize("action", ["cancel", "retry"])
def test_control_does_not_take_over_an_unaccepted_runtime(context, action):
    assert runtime._prepare(operation().model_copy(update={"action": action})) is None
    context[0].commit.assert_not_called()


@pytest.mark.parametrize("action", ["cancel", "retry"])
def test_control_keeps_accepted_attempt_after_knowledge_selection_changes(
    context, monkeypatch, action
):
    context[2].answer_generation_id = "a" * 32
    monkeypatch.setattr(runtime, "_has_native_knowledge", lambda *a: False)
    prepared = runtime._prepare(operation().model_copy(update={"action": action}))
    assert prepared is not None
    if action == "cancel":
        assert prepared["generation_id"] == "a" * 32


@pytest.mark.parametrize(
    "source", ["context", "selected_documents", "task", "scopes", "agent_default"]
)
@pytest.mark.parametrize("external", [False, True])
def test_native_knowledge_selection_uses_persisted_context_and_bindings(
    monkeypatch, source, external
):
    from app.services.chat import selected_knowledge, task_default_knowledge_bases
    from app.services.context import context_service

    db = MagicMock()
    spec = {}
    if source in ("task", "scopes"):
        spec["knowledgeBaseRefs" if source == "task" else "knowledgeBaseScopes"] = [
            {"id": 3}
        ]
    task = SimpleNamespace(id=9, json={"spec": spec})
    contexts = []
    if source in ("context", "selected_documents"):
        contexts = [
            SimpleNamespace(
                context_type="knowledge_base" if source == "context" else source,
                type_data={
                    "knowledge_id" if source == "context" else "knowledge_base_id": 3
                },
            )
        ]
    monkeypatch.setattr(context_service, "get_by_subtask", lambda *a: contexts)
    monkeypatch.setattr(
        task_default_knowledge_bases,
        "resolve_task_default_knowledge_base_ids",
        lambda *a: [3] if source == "agent_default" else [],
    )
    monkeypatch.setattr(
        selected_knowledge,
        "_build_wegent_refs_for_ids",
        lambda db, task, ids: [
            selected_knowledge.SelectedKnowledgeRef("wegent", str(kb_id), "test")
            for kb_id in ids
        ],
    )
    db.query.return_value.filter.return_value.all.return_value = [
        SimpleNamespace(
            json={"spec": {"source": {"type": "external"} if external else None}}
        )
    ]
    assert runtime._has_native_knowledge(db, task, operation()) is (not external)


@pytest.mark.asyncio
async def test_failure_after_acceptance_settles_only_its_captured_identity(
    context, monkeypatch
):
    def broken_detach(*args):
        raise OSError("fixture preparation failed")

    monkeypatch.setattr(
        "app.api.ws.chat_namespace._detach_retry_dispatch_objects", broken_detach
    )
    settle = AsyncMock()
    monkeypatch.setattr(runtime, "_preparation_failed", settle)
    tasks = BackgroundTasks()
    result = await runtime.execute_web_answer(operation(), tasks)
    assert result["handled"] and "error" in result
    assert tasks.tasks == []
    settle.assert_awaited_once_with(9, 12, context[2].answer_generation_id)
    assert len(context[2].answer_generation_id) == 32


def test_late_start_cannot_adopt_retry_identity(context):
    db, _, answer = context
    answer.answer_generation_id = "b" * 32
    with pytest.raises(HTTPException) as rejected:
        runtime._prepare(operation())
    assert rejected.value.status_code == 409
    assert answer.answer_generation_id == "b" * 32
    db.commit.assert_not_called()


def test_adapter_cannot_bypass_answer_access(context, monkeypatch):
    monkeypatch.setattr(runtime.task_access_store, "is_member", lambda *a, **k: False)
    with pytest.raises(HTTPException) as denied:
        runtime._prepare(operation())
    assert denied.value.status_code == 403
    context[0].commit.assert_not_called()


@pytest.mark.parametrize("surface", ["wework", "device"])
def test_unselected_runtime_keeps_its_existing_execution_path(context, surface):
    db, task, _ = context
    if surface == "device":
        task.json["spec"]["device_id"] = "device-1"
    else:
        task.client_origin = surface
    assert runtime._prepare(operation()) is None
    db.commit.assert_not_called()


@pytest.mark.parametrize("action", ["start", "retry", "cancel"])
@pytest.mark.parametrize("shell", ["Codex", "ClaudeCode"])
def test_server_selected_non_chat_runtime_is_not_taken_over(
    context, monkeypatch, action, shell
):
    db, _, answer = context
    monkeypatch.setattr(runtime, "_selected_shell", lambda *args: shell)

    assert runtime._prepare(operation().model_copy(update={"action": action})) is None
    db.commit.assert_not_called()


@pytest.mark.parametrize("change", ["shell", "origin", "device"])
@pytest.mark.parametrize("action", ["cancel", "retry"])
def test_control_follows_accepted_identity_after_runtime_metadata_changes(
    context, monkeypatch, change, action
):
    db, task, answer = context
    answer.answer_generation_id = "a" * 32
    if change == "shell":
        monkeypatch.setattr(runtime, "_selected_shell", lambda *args: "Codex")
    elif change == "origin":
        task.client_origin = "api"
    else:
        task.json["spec"]["device_id"] = "new-device"

    expected = {"generation_id": "a" * 32} if action == "cancel" else {"selected": True}
    assert (
        runtime._prepare(operation().model_copy(update={"action": action})) == expected
    )
    db.commit.assert_not_called()


@pytest.mark.parametrize("current", [None, "b" * 32])
def test_cancel_rejects_an_identity_captured_before_the_private_rpc(context, current):
    db, _, answer = context
    answer.answer_generation_id = current
    cancel = operation(expected_generation_id="a" * 32).model_copy(
        update={"action": "cancel"}
    )

    with pytest.raises(HTTPException) as stale:
        runtime._prepare(cancel)
    assert stale.value.status_code == 409
    db.commit.assert_not_called()


@pytest.mark.asyncio
async def test_accepted_turn_runs_existing_dispatcher_as_background_work(monkeypatch):
    kwargs = {"assistant_subtask": SimpleNamespace(id=12)}
    monkeypatch.setattr(runtime, "_prepare", lambda *a: kwargs)
    execute = AsyncMock()
    monkeypatch.setattr(runtime, "_execute", execute)
    tasks = BackgroundTasks()
    assert await runtime.execute_web_answer(operation(), tasks) == {
        "handled": True,
        "success": True,
    }
    execute.assert_not_awaited()
    await tasks()
    execute.assert_awaited_once_with(kwargs)


@pytest.mark.asyncio
async def test_web_runtime_explicitly_enables_evidence_for_start_and_retry(monkeypatch):
    trigger = AsyncMock()
    monkeypatch.setattr(
        "app.services.chat.trigger.unified.trigger_ai_response_unified", trigger
    )
    kwargs = {"assistant_subtask": SimpleNamespace(id=12)}

    await runtime._execute(kwargs)

    assert trigger.await_args.kwargs["enable_answer_evidence"] is True


@pytest.mark.asyncio
async def test_stale_cancel_never_sends_a_runtime_signal(monkeypatch):
    monkeypatch.setattr(runtime, "_prepare", lambda *a: {"generation_id": "a" * 32})
    monkeypatch.setattr(
        "app.api.ws.chat_namespace._mark_task_and_board_cancelling", lambda *a: False
    )
    from app.services.adapters.task_kinds import task_kinds_service

    signal = AsyncMock()
    monkeypatch.setattr(task_kinds_service, "_call_chat_shell_cancel", signal)
    request = operation().model_copy(update={"action": "cancel"})
    result = await runtime.execute_web_answer(request, BackgroundTasks())
    assert result["handled"] and "error" in result
    signal.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("alive", [True, False])
async def test_cancel_preserves_streamed_partial_and_runtime_terminal_ownership(
    monkeypatch, alive
):
    from app.services.adapters.task_kinds import task_kinds_service
    from app.services.chat.operations import cancel
    from app.services.chat.trigger import lifecycle

    monkeypatch.setattr(runtime, "_prepare", lambda *a: {"generation_id": "a" * 32})
    monkeypatch.setattr(
        "app.api.ws.chat_namespace._mark_task_and_board_cancelling", lambda *a: True
    )
    signal = AsyncMock(return_value=True)
    monkeypatch.setattr(task_kinds_service, "_call_chat_shell_cancel", signal)
    monkeypatch.setattr(cancel, "is_stream_alive", AsyncMock(return_value=alive))
    partial = {
        "value": "already streamed text",
        "blocks": [{"type": "text", "content": "already streamed text"}],
    }
    collect = AsyncMock(return_value=partial)
    monkeypatch.setattr(lifecycle, "collect_completed_result", collect)
    save = MagicMock(return_value=True)
    monkeypatch.setattr(runtime, "_cancel", save)
    publish = AsyncMock()
    monkeypatch.setattr(cancel, "publish_task_cancelled_events", publish)
    request = operation().model_copy(update={"action": "cancel"})
    result = await runtime.execute_web_answer(request, BackgroundTasks())
    assert result["success"] is True
    assert signal.await_args.args == (12, "a" * 32)
    if alive:
        save.assert_not_called()
        collect.assert_not_awaited()
        publish.assert_not_awaited()
    else:
        collect.assert_awaited_once_with(12, status="CANCELLED")
        assert save.call_args.args[1] == "a" * 32
        assert save.call_args.args[2]["value"] == "already streamed text"
        publish.assert_awaited_once_with(9, [12], 7)


def test_bridge_does_not_accept_uploaded_evidence():
    with pytest.raises(ValidationError):
        runtime.WebAnswerOperation(**operation().model_dump(), _answer_evidence=[])
