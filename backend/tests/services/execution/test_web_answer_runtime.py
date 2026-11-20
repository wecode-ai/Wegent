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
        "app.api.ws.chat_namespace._detach_retry_dispatch_objects", lambda *a: None
    )
    return db, task, answer


def test_start_prepares_existing_turn_without_writing(context):
    db, _, answer = context
    prepared = runtime._prepare(operation())
    assert prepared["assistant_subtask"] is answer
    assert prepared["payload"].message == "question"
    assert prepared["user"].id == 7
    assert prepared["user_subtask_id"] == 11
    db.commit.assert_not_called()


def test_disabled_deep_thinking_reaches_the_existing_trigger(context):
    prepared = runtime._prepare(operation(options={"enable_deep_thinking": False}))
    assert prepared["enable_deep_thinking"] is False


def test_turn_without_native_knowledge_keeps_existing_runtime(context, monkeypatch):
    monkeypatch.setattr(runtime, "_has_native_knowledge", lambda *a: False)
    assert runtime._prepare(operation()) is None
    context[0].commit.assert_not_called()


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


@pytest.mark.parametrize("shell", ["Codex", "ClaudeCode"])
def test_server_selected_non_chat_runtime_is_not_taken_over(
    context, monkeypatch, shell
):
    monkeypatch.setattr(runtime, "_selected_shell", lambda *args: shell)
    assert runtime._prepare(operation()) is None


def test_running_answer_is_rejected(context):
    context[2].status = SubtaskStatus.RUNNING
    with pytest.raises(HTTPException) as rejected:
        runtime._prepare(operation())
    assert rejected.value.status_code == 409


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


def test_bridge_does_not_accept_uploaded_evidence():
    with pytest.raises(ValidationError):
        runtime.WebAnswerOperation(**operation().model_dump(), _answer_evidence=[])
