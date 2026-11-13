from shared.event_reporting import emit_event, register_event_receiver


def test_receiver_accepts_immutable_mapping_payload():
    from types import MappingProxyType

    events = []

    class Receiver:
        def accepts(self, event_type):
            return True

        def receive(self, event):
            events.append(event)

    register_event_receiver(Receiver())
    try:
        emit_event(
            event_type="knowledge.kb.created",
            payload_factory=lambda: MappingProxyType({"kb_type": "native"}),
        )
        assert events[0]["data"] == {"kb_type": "native"}
    finally:
        register_event_receiver(None)


def test_absent_receiver_does_not_evaluate_fields():
    register_event_receiver(None)

    def fields():
        raise AssertionError("fields must not be evaluated")

    emit_event(event_type="knowledge.kb.created", fields_factory=fields)


def test_receiver_gets_snapshot_and_errors_are_isolated():
    events = []

    class Receiver:
        def accepts(self, event_type):
            return True

        def observation_limit(self, event_type):
            return 10

        def receive(self, event):
            events.append(event)

    values = {"kb_type": "original"}
    register_event_receiver(Receiver())
    try:
        emit_event(event_type="knowledge.kb.created", payload_factory=lambda: values)
        values["kb_type"] = "modified"
        assert events[0]["data"]["kb_type"] == "original"
        assert events[0]["event_id"]
        assert events[0]["occurred_at"].endswith("+00:00")
    finally:
        register_event_receiver(None)


def test_rejected_event_does_not_evaluate_factory():
    class Receiver:
        def accepts(self, event_type):
            return False

        def observation_limit(self, event_type):
            return 0

        def receive(self, event):
            raise AssertionError("must not receive")

    register_event_receiver(Receiver())
    try:
        emit_event(
            event_type="knowledge.kb.created",
            payload_factory=lambda: 1 / 0,
        )
    finally:
        register_event_receiver(None)


def test_receiver_exception_does_not_escape():
    class Receiver:
        def accepts(self, event_type):
            return True

        def observation_limit(self, event_type):
            return 0

        def receive(self, event):
            raise RuntimeError("receiver failed")

    register_event_receiver(Receiver())
    try:
        emit_event(event_type="knowledge.kb.created")
    finally:
        register_event_receiver(None)


def test_inherited_receiver_is_not_used_after_fork(monkeypatch):
    from shared.event_reporting import reporter

    events = []

    class Receiver:
        def accepts(self, event_type):
            return True

        def observation_limit(self, event_type):
            return 10

        def receive(self, event):
            events.append(event)

    register_event_receiver(Receiver())
    try:
        monkeypatch.setattr(reporter.os, "getpid", lambda: -1)
        emit_event(event_type="knowledge.kb.created")
        assert events == []
    finally:
        register_event_receiver(None)


def test_large_retrieval_snapshot_keeps_all_ownerships():
    from shared.event_reporting import (
        KnowledgeBaseDimensions,
        set_knowledge_base_provider,
    )

    events = []

    class Receiver:
        def accepts(self, event_type):
            return True

        def observation_limit(self, event_type):
            return 0

        def receive(self, event):
            events.append(event)

    register_event_receiver(Receiver())
    set_knowledge_base_provider(lambda kb_id: KnowledgeBaseDimensions(org_id="org"))
    try:
        emit_event(
            event_type="knowledge.retrieval.request.finished",
            payload_factory=lambda: {"knowledge_base_ids": list(range(150))},
        )
        assert len(events[0]["data"]["asset_org_by_kb"]) == 150
    finally:
        set_knowledge_base_provider(None)
        register_event_receiver(None)


def test_unregister_preserves_replacement_receiver():
    from shared.event_reporting import unregister_event_receiver

    first, replacement = object(), object()
    register_event_receiver(first)
    register_event_receiver(replacement)
    unregister_event_receiver(first)
    from shared.event_reporting import reporter

    assert reporter._current() is replacement
    unregister_event_receiver(replacement)
    assert reporter._current() is None
