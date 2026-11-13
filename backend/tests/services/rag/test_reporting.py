import asyncio
from types import SimpleNamespace

import pytest

from app.services.rag.reporting import (
    current_usage_context,
    report_document_usage_for_result,
    report_index_execution,
    report_query_execution,
    report_retrieval_request,
)


async def _result(value):
    return value


@pytest.mark.asyncio
async def test_mixed_restricted_response_reports_only_delivered_external_documents():
    from app.api.endpoints.internal.rag import (
        MixedRestrictedRetrieveResponse,
        RetrieveRecord,
    )
    from shared.event_reporting import register_event_receiver

    events = []

    class Receiver:
        def accepts(self, event_type):
            return event_type == "knowledge.usage.document.recorded"

        def receive(self, event):
            events.append(event)

    response = MixedRestrictedRetrieveResponse(
        retrieval_mode="rag_retrieval",
        restricted_safe_summary={
            "decision": "answer",
            "reason": "ok",
            "summary": "summary",
            "answer_guidance": "ok",
        },
        answer_contract="contract",
        message="ok",
        total=1,
        external_records=[
            RetrieveRecord(
                content="external", title="doc", knowledge_base_id=1, document_id=2
            )
        ],
    )
    register_event_receiver(Receiver())
    try:
        assert (
            await report_retrieval_request(
                entrypoint="chat",
                requested_kb_ids=[1],
                effective_kb_ids=[1],
                route_mode="rag_retrieval",
                execute=lambda: _result(response),
            )
            is response
        )
        assert [(event["kb_id"], event["document_id"]) for event in events] == [(1, 2)]
    finally:
        register_event_receiver(None)


@pytest.mark.asyncio
async def test_registered_actor_provider_is_called_once_for_nested_queries(
    mocker, facts
):
    from shared.event_reporting.dimensions import (
        ActorDimensions,
        set_actor_provider,
    )

    provider = mocker.Mock(
        return_value=ActorDimensions(org_id="org-1", org_version="v1")
    )
    set_actor_provider(provider)
    mocker.patch(
        "app.services.rag.reporting.is_event_reporting_enabled", return_value=True
    )
    usage_report = mocker.patch("app.services.rag.reporting.report_kb_usage")

    async def nested():
        return await report_retrieval_request(
            entrypoint="chat",
            requested_kb_ids=[1],
            effective_kb_ids=[1],
            route_mode="rag_retrieval",
            actor_user_id=42,
            execute=lambda: _result({"total": 0}),
        )

    try:
        await report_retrieval_request(
            entrypoint="chat",
            requested_kb_ids=[1],
            effective_kb_ids=[1],
            route_mode="rag_retrieval",
            actor_user_id=42,
            execute=nested,
        )
        provider.assert_called_once_with(42)
        assert usage_report.call_args.kwargs["actor_org_id"] == "org-1"
        assert usage_report.call_args.kwargs["actor_org_version"] == "v1"
    finally:
        set_actor_provider(None)


@pytest.mark.asyncio
async def test_actor_provider_failure_does_not_change_query(mocker, facts):
    from shared.event_reporting.dimensions import set_actor_provider

    set_actor_provider(mocker.Mock(side_effect=RuntimeError("unavailable")))
    mocker.patch(
        "app.services.rag.reporting.is_event_reporting_enabled", return_value=True
    )
    try:
        result = {"total": 0}
        assert (
            await report_retrieval_request(
                entrypoint="chat",
                requested_kb_ids=[1],
                effective_kb_ids=[1],
                route_mode="rag_retrieval",
                actor_user_id=42,
                execute=lambda: _result(result),
            )
            is result
        )
        assert "actor_org_id" not in facts[0][1]["data"]
    finally:
        set_actor_provider(None)


@pytest.mark.asyncio
async def test_disabled_reporting_does_not_call_actor_provider(mocker, facts):
    from shared.event_reporting.dimensions import set_actor_provider

    provider = mocker.Mock()
    set_actor_provider(provider)
    mocker.patch(
        "app.services.rag.reporting.is_event_reporting_enabled", return_value=False
    )
    try:
        await report_retrieval_request(
            entrypoint="chat",
            requested_kb_ids=[1],
            effective_kb_ids=[1],
            route_mode="rag_retrieval",
            actor_user_id=42,
            execute=lambda: _result({"total": 0}),
        )
        provider.assert_not_called()
    finally:
        set_actor_provider(None)


@pytest.mark.parametrize(
    "value",
    [None, "invalid", {"org_id": "org"}, pytest.param("too_long", id="oversized")],
)
def test_invalid_actor_provider_result_is_ignored(value):
    from shared.event_reporting.dimensions import (
        ActorDimensions,
        resolve_actor_dimensions,
        set_actor_provider,
    )

    if value == "too_long":
        value = ActorDimensions(org_id="x" * 257)
    set_actor_provider(lambda _: value)
    try:
        assert resolve_actor_dimensions(42) is None
    finally:
        set_actor_provider(None)


@pytest.mark.asyncio
async def test_document_usage_records_only_final_returned_documents(mocker, facts):
    report = mocker.patch("app.services.rag.reporting.report_document_usage")
    selected = [{"knowledge_base_id": 2, "document_id": 22}]
    await report_retrieval_request(
        entrypoint="chat",
        requested_kb_ids=[1, 2],
        effective_kb_ids=[1, 2],
        route_mode="rag_retrieval",
        invocation_id="inv-1",
        execute=lambda: _result({"records": selected, "total": 1}),
    )
    assert report.call_count == 1
    assert report.call_args.args[0] is selected
    assert report.call_args.kwargs["invocation_id"] == "inv-1"


@pytest.mark.asyncio
async def test_failed_or_restricted_request_does_not_report_raw_documents(
    mocker, facts
):
    report = mocker.patch("app.services.rag.reporting.report_document_usage")

    async def failed():
        raise RuntimeError("retrieval failed")

    arguments = dict(
        entrypoint="chat",
        requested_kb_ids=[1],
        effective_kb_ids=[1],
        route_mode="rag_retrieval",
    )
    with pytest.raises(RuntimeError, match="retrieval failed"):
        await report_retrieval_request(**arguments, execute=failed)
    await report_retrieval_request(
        **arguments,
        restricted_mode=True,
        execute=lambda: _result({"restricted_safe_summary": "safe", "total": 1}),
    )
    report.assert_not_called()


@pytest.fixture
def facts(mocker):
    events = []
    mocker.patch(
        "app.services.rag.reporting.observe",
        side_effect=lambda name, factory: events.append((name, factory())),
    )
    mocker.patch("app.services.rag.reporting.report_kb_usage")
    return events


@pytest.mark.asyncio
async def test_request_preserves_result_without_scanning(facts):
    class UnreadableRecords:
        def __iter__(self):
            raise AssertionError("collection must not inspect records")

    result = {"records": UnreadableRecords(), "total": 4}
    returned = await report_retrieval_request(
        entrypoint="mcp",
        requested_kb_ids=[1, 2],
        effective_kb_ids=[1],
        route_mode="rag_retrieval",
        execute=lambda: _result(result),
    )
    assert returned is result
    frame = facts[0][1]
    assert frame["status"] == "success"
    assert frame["data"]["result_count"] == 4
    assert frame["data"]["client_surface"] == "mcp"
    assert "hit_kb_count" not in frame["data"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "entrypoint,surface",
    [
        ("openapi", "knowledge_web"),
        ("chat", "chat_shell"),
        ("openapi", "external_api"),
        ("mcp", "mcp"),
    ],
)
@pytest.mark.parametrize("fails", [False, True])
async def test_query_surface_is_preserved_for_each_terminal_status(
    facts, entrypoint, surface, fails
):
    async def execute():
        assert current_usage_context().client_surface == surface
        if fails:
            raise RuntimeError("query failed")
        return {"total": 0}

    arguments = dict(
        entrypoint=entrypoint,
        client_surface=surface,
        requested_kb_ids=[7],
        effective_kb_ids=[7],
        route_mode="rag_retrieval",
        execute=execute,
    )
    if fails:
        with pytest.raises(RuntimeError, match="query failed"):
            await report_retrieval_request(**arguments)
    else:
        assert await report_retrieval_request(**arguments) == {"total": 0}
    assert len(facts) == 1
    assert facts[0][1]["data"]["client_surface"] == surface
    assert facts[0][1]["data"]["entrypoint"] == entrypoint
    assert facts[0][1]["status"] == ("failure" if fails else "success")
    assert current_usage_context() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [RuntimeError("original"), asyncio.CancelledError()])
async def test_request_preserves_original_exception(facts, error):
    async def fail():
        raise error

    with pytest.raises(type(error)) as caught:
        await report_retrieval_request(
            entrypoint="api",
            requested_kb_ids=[],
            effective_kb_ids=[],
            route_mode="auto",
            execute=fail,
        )
    assert caught.value is error
    assert facts[0][1]["status"] == (
        "cancelled" if isinstance(error, asyncio.CancelledError) else "failure"
    )
    assert facts[0][1]["error_code"] == type(error).__name__


@pytest.mark.asyncio
async def test_query_direct_injection_has_no_remote_fact(facts):
    result = {}
    assert (
        await report_query_execution(
            execution_mode="remote",
            spec=SimpleNamespace(route_mode="direct_injection"),
            execute=lambda: _result(result),
        )
        is result
    )
    assert facts == []


@pytest.mark.asyncio
async def test_index_copies_existing_count(facts):
    result = {"indexed_count": 3}
    assert (
        await report_index_execution(
            execution_mode="remote",
            spec=SimpleNamespace(knowledge_base_id=7, document_id=9),
            execute=lambda: _result(result),
        )
        is result
    )
    assert facts[0][1]["data"]["chunk_count"] == 3


@pytest.mark.asyncio
async def test_unloaded_response_property_is_not_read(facts):
    class Response:
        @property
        def total(self):
            raise AssertionError("must not load properties")

    result = Response()
    assert (
        await report_retrieval_request(
            entrypoint="api",
            requested_kb_ids=[],
            effective_kb_ids=[],
            route_mode="auto",
            execute=lambda: _result(result),
        )
        is result
    )
    assert facts[0][1]["data"]["result_count"] is None


@pytest.mark.asyncio
async def test_request_propagates_usage_identity_and_reports_unique_kbs(mocker, facts):
    observed_context = None

    async def execute():
        nonlocal observed_context
        observed_context = current_usage_context()
        return {"total": 0}

    report_kb_usage = mocker.patch("app.services.rag.reporting.report_kb_usage")
    await report_retrieval_request(
        entrypoint="chat",
        requested_kb_ids=[11, 12],
        effective_kb_ids=[11, 11, 12],
        route_mode="rag_retrieval",
        actor_user_id=42,
        task_id=91,
        subtask_id=92,
        invocation_id="invocation-1",
        execute=execute,
    )

    assert observed_context is not None
    assert observed_context.invocation_id == "invocation-1"
    assert observed_context.actor_user_id == 42
    assert observed_context.client_surface == "chat_shell"
    assert current_usage_context() is None
    assert facts[0][1]["data"]["invocation_id"] == "invocation-1"
    report_kb_usage.assert_called_once_with(
        invocation_id="invocation-1",
        kb_ids=[11, 11, 12],
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
        task_id=91,
        subtask_id=92,
    )


@pytest.mark.asyncio
async def test_request_always_restores_context_when_optional_usage_reporting_fails(
    mocker, facts
):
    mocker.patch(
        "app.services.rag.reporting.report_kb_usage",
        side_effect=RuntimeError("optional reporting failed"),
    )

    result = {"total": 0}
    returned = await report_retrieval_request(
        entrypoint="chat",
        requested_kb_ids=[11],
        effective_kb_ids=[11],
        route_mode="rag_retrieval",
        execute=lambda: _result(result),
    )

    assert returned is result
    assert current_usage_context() is None


def test_document_usage_reporting_never_interrupts_retrieval(mocker):
    usage = SimpleNamespace(
        invocation_id="invocation-1",
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
        task_id=91,
        subtask_id=92,
        actor_dimensions=None,
    )
    mocker.patch("app.services.rag.reporting.current_usage_context", return_value=usage)
    report_document_usage = mocker.patch(
        "app.services.rag.reporting.report_document_usage",
        side_effect=RuntimeError("optional reporting failed"),
    )

    report_document_usage_for_result([{"document_id": 1}])

    report_document_usage.assert_called_once()


@pytest.mark.asyncio
async def test_registered_receiver_gets_all_successful_knowledge_usage():
    from shared.event_reporting import register_event_receiver

    class Receiver:
        def __init__(self):
            self.events = []

        def accepts(self, event_type):
            return True

        def observation_limit(self, event_type):
            return 0

        def receive(self, event):
            self.events.append(event)

    receiver = Receiver()
    register_event_receiver(receiver)
    try:
        await report_retrieval_request(
            entrypoint="chat",
            requested_kb_ids=list(range(150)),
            effective_kb_ids=list(range(150)),
            route_mode="rag_retrieval",
            actor_user_id=42,
            execute=lambda: _result({"total": 0}),
        )
    finally:
        register_event_receiver(None)
    usage = [
        event
        for event in receiver.events
        if event["event_type"] == "knowledge.usage.kb.recorded"
    ]
    requests = [
        event
        for event in receiver.events
        if event["event_type"] == "knowledge.retrieval.request.finished"
    ]
    assert len(requests) == 1
    assert requests[0]["data"]["knowledge_base_ids"] == list(range(150))
    assert len(usage) == 150
    assert {event["kb_id"] for event in usage} == set(range(150))
    assert all(event["data"]["actor_user_id"] == 42 for event in usage)


@pytest.mark.asyncio
async def test_nested_request_reports_only_final_delivery(mocker):
    from shared.event_reporting import register_event_receiver

    events = []
    receiver = mocker.Mock()
    receiver.accepts.return_value = True
    receiver.receive.side_effect = events.append
    records = [{"knowledge_base_id": 1, "document_id": 2}]
    args = dict(
        entrypoint="chat",
        requested_kb_ids=[1],
        effective_kb_ids=[1],
        route_mode="rag_retrieval",
        actor_user_id=7,
    )

    async def inner():
        return await report_retrieval_request(
            **args, execute=lambda: _result({"records": records})
        )

    register_event_receiver(receiver)
    try:
        await report_retrieval_request(**args, execute=inner)
    finally:
        register_event_receiver(None)
    assert (
        len(
            [
                e
                for e in events
                if e["event_type"] == "knowledge.usage.document.recorded"
            ]
        )
        == 1
    )
    assert (
        len([e for e in events if e["event_type"] == "knowledge.usage.kb.recorded"])
        == 1
    )
