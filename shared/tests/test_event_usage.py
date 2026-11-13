# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.event_reporting.catalogs.knowledge import usage


def test_document_usage_deduplicates_chunks_and_keeps_existing_identities(
    monkeypatch,
) -> None:
    events = []
    monkeypatch.setattr(usage, "is_event_reporting_enabled", lambda _: True)
    monkeypatch.setattr(
        usage,
        "observe",
        lambda event_type, factory: events.append((event_type, factory())),
    )

    usage.report_document_usage(
        [
            {"knowledge_base_id": 11, "document_id": 21},
            {"knowledge_base_id": 11, "document_id": 21},
            {
                "knowledge_base_id": 11,
                "metadata": {"document_id": 22},
            },
            {"knowledge_base_id": 11},
        ],
        invocation_id="invocation-1",
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
    )

    assert [event_type for event_type, _ in events] == [
        "knowledge.usage.document.recorded",
        "knowledge.usage.document.recorded",
    ]
    assert {event["document_id"] for _, event in events} == {21, 22}
    assert all(event["data"]["expected_document_count"] == 2 for _, event in events)
    assert all(event["data"]["coverage_state"] == "partial" for _, event in events)
    assert all(event["data"]["actor_user_id"] == 42 for _, event in events)
    assert all(event["data"]["client_surface"] == "chat_shell" for _, event in events)


def test_kb_usage_emits_one_fact_per_unique_kb(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(usage, "is_event_reporting_enabled", lambda _: True)
    monkeypatch.setattr(
        usage,
        "observe",
        lambda event_type, factory: events.append((event_type, factory())),
    )

    usage.report_kb_usage(
        invocation_id="invocation-1",
        kb_ids=[11, 11, 12],
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
    )

    assert [event["kb_id"] for _, event in events] == [11, 12]


def test_organization_dimensions_are_optional_and_preserve_fact_key(monkeypatch):
    events = []
    monkeypatch.setattr(usage, "is_event_reporting_enabled", lambda _: True)
    monkeypatch.setattr(
        usage, "observe", lambda name, factory: events.append(factory())
    )
    arguments = dict(
        invocation_id="inv-1",
        kb_ids=[11],
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
    )
    usage.report_kb_usage(**arguments)
    baseline = events.pop()
    assert "actor_org_id" not in baseline["data"]
    assert "actor_org_version" not in baseline["data"]
    usage.report_kb_usage(**arguments, actor_org_id="org-1", actor_org_version="v1")
    enriched = events.pop()
    assert enriched["fact_key_parts"] == baseline["fact_key_parts"]
    assert enriched["data"] == {
        **baseline["data"],
        "actor_org_id": "org-1",
        "actor_org_version": "v1",
    }


def test_document_usage_carries_organization_only_when_present(monkeypatch):
    events = []
    monkeypatch.setattr(usage, "is_event_reporting_enabled", lambda _: True)
    monkeypatch.setattr(
        usage, "observe", lambda name, factory: events.append(factory())
    )
    arguments = dict(
        records=[{"knowledge_base_id": 11, "document_id": 22}],
        invocation_id="inv",
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
    )
    usage.report_document_usage(**arguments)
    baseline = events.pop()
    usage.report_document_usage(
        **arguments, actor_org_id="org-1", actor_org_version="v1"
    )
    enriched = events.pop()
    assert enriched["fact_key_parts"] == baseline["fact_key_parts"]
    assert enriched["data"] == {
        **baseline["data"],
        "actor_org_id": "org-1",
        "actor_org_version": "v1",
    }


def test_document_usage_does_not_scan_records_when_reporting_is_disabled(
    monkeypatch,
) -> None:
    class UnreadableRecords:
        def __iter__(self):
            raise AssertionError("disabled usage reporting must not scan records")

    monkeypatch.setattr(usage, "is_event_reporting_enabled", lambda _: False)

    usage.report_document_usage(
        UnreadableRecords(),
        invocation_id="invocation-1",
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
    )


def test_document_usage_never_breaks_service_for_malformed_identity(
    monkeypatch,
) -> None:
    events = []
    monkeypatch.setattr(usage, "is_event_reporting_enabled", lambda _: True)
    monkeypatch.setattr(
        usage,
        "observe",
        lambda event_type, factory: events.append((event_type, factory())),
    )

    usage.report_document_usage(
        [{"knowledge_base_id": {"invalid": True}, "document_id": [1]}],
        invocation_id="invocation-1",
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
    )

    assert events == []


def test_document_usage_never_breaks_service_for_failing_iterator(monkeypatch) -> None:
    class FailingRecords:
        def __iter__(self):
            raise RuntimeError("retrieval collection failed during optional reporting")

    monkeypatch.setattr(usage, "is_event_reporting_enabled", lambda _: True)

    usage.report_document_usage(
        FailingRecords(),
        invocation_id="invocation-1",
        actor_user_id=42,
        actor_type="user",
        entrypoint="chat",
        client_surface="chat_shell",
    )
