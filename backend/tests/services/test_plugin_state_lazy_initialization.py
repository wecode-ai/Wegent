"""Lazy initialization and delayed backfill preserve new writes and old receipts."""

from copy import deepcopy

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.device.plugin_sync_protocol import lock_installed_plugin_state
from app.services.plugin_local_sync import _lookup_operation
from app.services.plugin_state_store import ensure_plugin_state
from app.services.plugin_write_errors import PluginWriteError
from scripts.backfill_plugin_states import backfill


@pytest.fixture
def history(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'lazy-states.db'}")
    Kind.__table__.create(engine)
    PluginState.__table__.create(engine)
    sessions = sessionmaker(engine)
    with sessions.begin() as db:
        plugin = Kind(
            user_id=151,
            kind="InstalledPlugin",
            namespace="default",
            name="gitlab",
            json={"spec": {"revision": 3}},
            is_active=False,
        )
        db.add(plugin)
        db.flush()
        installed_id = plugin.id
        receipt = {
            "operationId": "old-uninstall",
            "requestHash": "hash",
            "installedId": installed_id,
            "installedRevision": 3,
            "action": "uninstall",
            "intentOrder": 7,
        }
        document = {
            "spec": {
                "revision": 5,
                "generation": 7677,
                "devices": {
                    "desktop": {
                        "complete_generation": 7600,
                        "plugins": {str(installed_id): 7677},
                    }
                },
                "localIntents": {"native": {str(installed_id): receipt}},
                "localIntentOrders": {"native": {str(installed_id): 7}},
            }
        }
        old = Kind(
            user_id=151,
            kind="PluginSyncState",
            namespace="plugin-sync",
            name="account",
            json=document,
            is_active=True,
        )
        db.add(old)
        db.flush()
        source_id = old.id
    yield sessions, installed_id, source_id, document
    engine.dispose()


def test_cold_request_lookup_uses_frozen_history_without_creating_state(history):
    sessions, installed_id, _source_id, document = history
    with sessions() as db:
        receipt = _lookup_operation(db, 151, "native", "old-uninstall")
        assert receipt == document["spec"]["localIntents"]["native"][str(installed_id)]
        assert db.query(PluginState).count() == 0
        assert _lookup_operation(db, 152, "native", "old-uninstall") is None


def test_first_touch_inherits_full_history_without_mutating_the_baseline(history):
    sessions, installed_id, source_id, document = history
    with sessions() as db:
        state = lock_installed_plugin_state(db, 151, installed_id)
        db.commit()
        assert state.installed_kind_id == installed_id
        assert state.json["spec"]["generation"] == 7677
        assert state.json["spec"]["devices"] == document["spec"]["devices"]
        assert state.json["spec"]["localIntents"] == document["spec"]["localIntents"]
        assert (
            state.json["spec"]["localIntentOrders"]
            == document["spec"]["localIntentOrders"]
        )
        assert db.get(Kind, source_id).json == document
        assert db.query(PluginState).count() == 1


def test_backfill_skips_new_writes_and_never_restores_a_frozen_receipt(history):
    sessions, installed_id, source_id, _document = history
    with sessions() as db:
        state = lock_installed_plugin_state(db, 151, installed_id)
        db.commit()
        changed = deepcopy(state.json)
        changed["spec"].update(
            generation=9000,
            revision=10,
            localIntents={"native": {}},
            localIntentOrders={"native": {str(installed_id): 99}},
        )
        state.json = changed
        db.commit()
        expected = deepcopy(state.json)
    result = backfill(
        sessions,
        user_id=151,
        batch_size=1,
        apply=True,
        pause_ms=0,
        report=lambda _line: None,
    )
    assert result["processed"] == 2 and result["skipped"] == 1
    with sessions() as db:
        state = db.query(PluginState).filter_by(plugin_key="gitlab").one()
        assert state.json == expected
        assert _lookup_operation(db, 151, "native", "old-uninstall") is None
        assert db.get(Kind, source_id).is_active
    again = backfill(sessions, apply=True, pause_ms=0, report=lambda _line: None)
    assert again["skipped"] == 2


def test_dry_run_and_resumed_backfill_keep_source_and_completed_rows(history):
    sessions, installed_id, source_id, document = history
    result = backfill(sessions, user_id=151, pause_ms=0, report=lambda _line: None)
    assert result["pending"] == 2
    with sessions() as db:
        assert db.query(PluginState).count() == 0
    result = backfill(
        sessions,
        user_id=151,
        after_id=installed_id,
        apply=True,
        pause_ms=0,
        report=lambda _line: None,
    )
    assert result["processed"] == 1 and result["resume_after_id"] == source_id
    with sessions() as db:
        assert db.query(PluginState).one().json == document
        assert db.get(Kind, source_id).json == document


def test_ambiguous_legacy_history_is_rejected_only_when_first_used(history):
    sessions, installed_id, _source_id, document = history
    with sessions.begin() as db:
        db.add(
            Kind(
                user_id=151,
                kind="PluginSyncState",
                namespace="plugin-sync",
                name="account",
                json=document,
                is_active=True,
            )
        )
    with (
        sessions() as db,
        pytest.raises(PluginWriteError, match="plugin_write_conflict"),
    ):
        ensure_plugin_state(db, 151, "gitlab", installed_kind_id=installed_id)


def test_interrupted_backfill_reports_a_cursor_before_the_failed_row(
    history, monkeypatch
):
    import json

    from scripts import backfill_plugin_states as script

    sessions, installed_id, source_id, _document = history
    original = script.backfill_one
    reports = []

    def interrupt(db, identity, *args):
        if identity == source_id:
            raise RuntimeError("simulated interruption")
        return original(db, identity, *args)

    monkeypatch.setattr(script, "backfill_one", interrupt)
    with pytest.raises(RuntimeError, match="simulated interruption"):
        backfill(sessions, apply=True, pause_ms=0, report=reports.append)
    cursor = json.loads(reports[-1])["resume_after_id"]
    assert cursor == installed_id
    with sessions() as db:
        state = db.query(PluginState).one()
        value = deepcopy(state.json)
        value["spec"]["generation"] = 9999
        state.json = value
        db.commit()
    monkeypatch.setattr(script, "backfill_one", original)
    resumed = backfill(
        sessions, after_id=cursor, apply=True, pause_ms=0, report=lambda _line: None
    )
    assert resumed["processed"] == 1
    with sessions() as db:
        assert (
            db.query(PluginState)
            .filter_by(plugin_key="gitlab")
            .one()
            .json["spec"]["generation"]
            == 9999
        )
