from app.services.knowledge import event_logging


def test_emit_fact_snapshots_emits_only_explicitly_committed_facts(mocker):
    emitted = []
    mocker.patch.object(
        event_logging,
        "observe",
        side_effect=lambda name, factory: emitted.append((name, factory())),
    )
    snapshots = (
        ("knowledge.document.created", {"document_id": 7}),
        ("knowledge.document.deleted", {"document_id": 8}),
    )

    event_logging.emit_fact_snapshots(snapshots)

    assert emitted == list(snapshots)


def test_emit_fact_snapshots_is_best_effort(mocker):
    observe = mocker.patch.object(
        event_logging,
        "observe",
        side_effect=[RuntimeError("transport unavailable"), None],
    )

    event_logging.emit_fact_snapshots(
        (
            ("knowledge.document.created", {}),
            ("knowledge.document.deleted", {}),
        )
    )

    assert observe.call_count == 2
