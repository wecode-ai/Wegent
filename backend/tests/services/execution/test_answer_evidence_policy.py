"""Only an opted-in Web execution can promote private evidence to trusted data."""

from unittest.mock import AsyncMock

import pytest

from app.services.execution.inprocess_chat import ChatShellBridgeTransport
from app.services.execution.response_parser import ResponsesAPIEventParser
from app.services.knowledge.answer_evidence import TrustedEvidence
from shared.models import ExecutionRequest


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "enabled,device,shell,expected",
    [
        (False, None, "Chat", False),
        (True, None, "Chat", True),
        (True, "device", "Chat", False),
        (True, None, "Codex", False),
    ],
)
async def test_unified_trigger_defaults_to_api_behavior_despite_payload(
    monkeypatch, enabled, device, shell, expected
):
    from types import SimpleNamespace

    from app.services.chat.trigger import unified
    from app.services.execution import execution_dispatcher

    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        bot=[{"shell_type": shell}],
        enable_answer_evidence=True,
    )
    monkeypatch.setattr(
        unified, "build_execution_request", AsyncMock(return_value=request)
    )
    dispatch = AsyncMock()
    monkeypatch.setattr(execution_dispatcher, "dispatch", dispatch)
    await unified.trigger_ai_response_unified(
        task=SimpleNamespace(id=1, client_origin="frontend"),
        assistant_subtask=SimpleNamespace(id=2),
        team=object(),
        user=object(),
        message="Read",
        payload=SimpleNamespace(enable_answer_evidence=True),
        task_room="task:1",
        device_id=device,
        **({"enable_answer_evidence": True} if enabled else {}),
    )

    assert dispatch.await_args.args[0].enable_answer_evidence is expected


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
async def test_package_completion_requires_explicit_evidence_capability(enabled):
    emitter = AsyncMock()
    bridge = ChatShellBridgeTransport(
        emitter,
        ResponsesAPIEventParser(),
        1,
        2,
        user_id=3,
        enable_answer_evidence=enabled,
    )
    await bridge.send(
        "response.completed",
        1,
        2,
        {"response": {"output": [], "_answer_evidence": []}},
    )

    result = emitter.emit.await_args.args[0].result
    if enabled:
        assert isinstance(result["_answer_evidence"], TrustedEvidence)
    else:
        assert "_answer_evidence" not in result
