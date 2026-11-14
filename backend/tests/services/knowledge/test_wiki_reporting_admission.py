from types import SimpleNamespace

import pytest

from app.services.knowledge.wiki_reporting import binding_fact, wiki_request
from shared.event_reporting import register_event_receiver


@pytest.mark.asyncio
async def test_binding_event_is_independent_of_request_event_admission():
    events = []

    class Receiver:
        def accepts(self, event_type):
            return event_type == "knowledge.wiki.binding.changed"

        def receive(self, event):
            events.append(event)

    @wiki_request("bind")
    async def bind():
        binding_fact(None, SimpleNamespace(id=2, kind_id=1), "created")

    register_event_receiver(Receiver())
    try:
        await bind()
        assert [event["event_type"] for event in events] == [
            "knowledge.wiki.binding.changed"
        ]
    finally:
        register_event_receiver(None)
