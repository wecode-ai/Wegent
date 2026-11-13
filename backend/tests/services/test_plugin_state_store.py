"""Plugin identities survive retries without account-wide metadata writes."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.plugin_state_store import ensure_plugin_state


def test_repeated_materialization_preserves_the_existing_document(test_db, test_user):
    state = ensure_plugin_state(test_db, test_user.id, "enterprise-mail")
    document = deepcopy(state.json)
    document["spec"].update(revision=4, generation=9)
    state.json = document
    state.installed_kind_id = 123
    test_db.commit()

    same = ensure_plugin_state(test_db, test_user.id, "enterprise-mail")

    assert same.id == state.id
    assert same.json == document
    assert same.installed_kind_id == 123
    assert test_db.query(PluginState).count() == 1


def test_simultaneous_first_materialization_has_one_durable_identity(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'plugin-identities.db'}",
        connect_args={"check_same_thread": False, "timeout": 10},
    )
    PluginState.__table__.create(engine)
    Kind.__table__.create(engine)
    ready = Barrier(4)

    def create():
        with Session(engine) as db:
            ready.wait(timeout=5)
            state = ensure_plugin_state(db, 151, "enterprise-gitlab")
            result = state.id
            db.commit()
            return result

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(lambda _: create(), range(4)))
        assert len(set(ids)) == 1
        with Session(engine) as db:
            assert db.query(PluginState).count() == 1
            another = ensure_plugin_state(db, 151, "enterprise-mail")
            assert another.id != ids[0]
            other_user = ensure_plugin_state(db, 152, "enterprise-gitlab")
            assert other_user.id not in {ids[0], another.id}
            db.commit()
    finally:
        engine.dispose()
