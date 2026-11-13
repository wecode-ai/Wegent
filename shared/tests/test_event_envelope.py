from shared.event_reporting.envelope import build_fact_key


def test_fact_key_preserves_missing_and_reserved_positions():
    key = lambda parts: build_fact_key("knowledge.test", parts)
    assert key((None, 7)) != key((7,))
    assert key((None,)) != key(("~",))
    assert key(()) != key(("",))
    assert key(("~",)) != key(("%7E",))
    assert key((7,)) == "v1|knowledge.test|7"
