# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Redis-backed Kind reader cache."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.models.kind import Kind
from app.services.readers.kind_cache import (
    _GENERATION_KEY,
    _MISS_SENTINEL,
    CachedKindReader,
    KindCacheStore,
    _after_commit,
    _after_rollback,
    _kind_from_payload,
    _kind_to_payload,
    install_kind_change_listener,
    register_kind_cache_invalidation,
)
from app.services.readers.kinds import KindType, _create_reader


class FakeStore:
    """In-memory stand-in for KindCacheStore."""

    def __init__(self):
        self.data = {}
        self.generation = "0"
        self.mget_calls = 0

    def get_many(self, keys):
        self.mget_calls += 1
        entries = {}
        for key in keys:
            if key not in self.data:
                continue
            entry_generation, kind = self.data[key]
            if entry_generation == self.generation:
                entries[key] = kind
        return entries, self.generation

    def get(self, key):
        entries, generation = self.get_many([key])
        return key in entries, entries.get(key), generation

    def set(self, key, generation, kind, ttl):
        self.data[key] = (generation, kind)

    def bump_generation(self):
        self.generation = str(int(self.generation) + 1)


def _make_kind(kind_id=1, user_id=10, name="mybot", namespace="default"):
    now = datetime(2026, 9, 18, 18, 0, 0)
    return SimpleNamespace(
        id=kind_id,
        user_id=user_id,
        kind=KindType.BOT.value,
        name=name,
        namespace=namespace,
        json={"kind": "Bot"},
        is_active=True,
        created_at=now,
        updated_at=now,
    )


def _make_reader(store):
    base = MagicMock()
    return CachedKindReader(base, store), base


def _make_session():
    engine = create_engine("sqlite://")
    Kind.__table__.create(engine)
    return sessionmaker(bind=engine)()


def _persisted_kind(name="mybot"):
    return Kind(
        user_id=10,
        kind=KindType.BOT.value,
        name=name,
        namespace="default",
        json={"kind": "Bot"},
        is_active=True,
    )


def test_payload_round_trip():
    kind = _make_kind()
    payload = _kind_to_payload(kind)
    restored = _kind_from_payload(payload)
    assert restored.id == kind.id
    assert restored.user_id == kind.user_id
    assert restored.kind == "Bot"
    assert restored.name == kind.name
    assert restored.namespace == kind.namespace
    assert restored.json == kind.json
    assert restored.is_active is True
    assert restored.created_at == kind.created_at
    assert restored.updated_at == kind.updated_at


def test_payload_round_trip_miss():
    assert _kind_to_payload(None) == _MISS_SENTINEL
    assert _kind_from_payload(_MISS_SENTINEL) is None


def test_get_by_id_caches_hit():
    store = FakeStore()
    reader, base = _make_reader(store)
    kind = _make_kind()
    base.get_by_id.return_value = kind

    assert reader.get_by_id(MagicMock(), KindType.BOT, 1) is kind
    assert reader.get_by_id(MagicMock(), KindType.BOT, 1) is kind
    base.get_by_id.assert_called_once()


def test_get_by_id_caches_miss():
    store = FakeStore()
    reader, base = _make_reader(store)
    base.get_by_id.return_value = None

    assert reader.get_by_id(MagicMock(), KindType.BOT, 404) is None
    assert reader.get_by_id(MagicMock(), KindType.BOT, 404) is None
    base.get_by_id.assert_called_once()


def test_get_personal_and_public_use_separate_keys():
    store = FakeStore()
    reader, base = _make_reader(store)
    base.get_personal.return_value = _make_kind(user_id=10)
    base.get_public.return_value = _make_kind(kind_id=99, user_id=0)

    db = MagicMock()
    personal = reader.get_personal(db, 10, KindType.BOT, "default", "mybot")
    public = reader.get_public(db, KindType.BOT, "default", "mybot")

    assert personal.user_id == 10
    assert public.user_id == 0
    base.get_personal.assert_called_once()
    base.get_public.assert_called_once()


def test_get_by_ids_uses_per_item_cache():
    store = FakeStore()
    reader, base = _make_reader(store)
    base.get_by_id.side_effect = lambda db, kind, rid: _make_kind(kind_id=rid)
    base.get_by_ids.side_effect = lambda db, kind, rids: [
        _make_kind(kind_id=rid) for rid in rids
    ]

    db = MagicMock()
    first = reader.get_by_ids(db, KindType.BOT, [1, 2, 3])
    second = reader.get_by_ids(db, KindType.BOT, [1, 2, 3])

    assert [k.id for k in first] == [1, 2, 3]
    assert [k.id for k in second] == [1, 2, 3]
    base.get_by_ids.assert_called_once()  # one batch load, not three
    base.get_by_id.assert_not_called()
    assert store.mget_calls == 2  # one batch lookup per call


def test_get_by_ids_empty():
    store = FakeStore()
    reader, base = _make_reader(store)
    assert reader.get_by_ids(MagicMock(), KindType.BOT, []) == []
    base.get_by_id.assert_not_called()
    base.get_by_ids.assert_not_called()


def test_get_by_ids_deduplicates_and_skips_missing_rows():
    store = FakeStore()
    reader, base = _make_reader(store)
    base.get_by_ids.side_effect = lambda db, kind, rids: [
        _make_kind(kind_id=rid) for rid in rids if rid != 2
    ]

    result = reader.get_by_ids(MagicMock(), KindType.BOT, [1, 2, 1, 3])

    assert [k.id for k in result] == [1, 3]
    base.get_by_ids.assert_called_once()


def test_generation_change_invalidates_all_lookup_keys():
    store = FakeStore()
    reader, base = _make_reader(store)
    db = MagicMock()
    base.get_personal.side_effect = [
        _make_kind(name="old-name"),
        _make_kind(name="new-name"),
    ]

    assert reader.get_personal(db, 10, KindType.BOT, "default", "mybot").name == (
        "old-name"
    )
    store.bump_generation()
    assert reader.get_personal(db, 10, KindType.BOT, "default", "mybot").name == (
        "new-name"
    )
    assert base.get_personal.call_count == 2


def test_on_change_delegates_to_base_and_bumps_generation():
    store = FakeStore()
    reader, base = _make_reader(store)

    reader.on_change(KindType.BOT, 1, 10, "default", "mybot")

    base.on_change.assert_called_once_with(KindType.BOT, 1, 10, "default", "mybot")
    assert store.generation == "1"


def test_invalidation_bumps_generation_only_after_commit():
    store = FakeStore()
    session = MagicMock()
    session.info = {}

    with patch("app.services.readers.kind_cache._invalidation_store", store):
        register_kind_cache_invalidation(session)
        assert store.generation == "0"
        _after_commit(session)

    assert store.generation == "1"
    assert session.info == {}


def test_rollback_discards_pending_invalidation():
    store = FakeStore()
    session = MagicMock()
    session.info = {}

    with patch("app.services.readers.kind_cache._invalidation_store", store):
        register_kind_cache_invalidation(session)
        _after_rollback(session)
        _after_commit(session)

    assert store.generation == "0"
    assert session.info == {}


def test_orm_changes_bump_generation_only_after_commit():
    store = FakeStore()
    session = _make_session()
    install_kind_change_listener()

    with patch("app.services.readers.kind_cache._invalidation_store", store):
        session.add(_persisted_kind())
        session.flush()
        assert store.generation == "0"
        session.commit()

    assert store.generation == "1"
    session.close()


def test_bulk_kind_update_bumps_generation_after_commit():
    store = FakeStore()
    session = _make_session()
    install_kind_change_listener()
    session.add(_persisted_kind())
    session.commit()
    store.generation = "0"

    with patch("app.services.readers.kind_cache._invalidation_store", store):
        session.query(Kind).filter(Kind.name == "mybot").update({"user_id": 20})
        assert store.generation == "0"
        session.commit()

    assert store.generation == "1"
    session.close()


def test_service_extension_wraps_the_cached_reader():
    extension = MagicMock()
    extension.wrap.side_effect = lambda base: base

    with (
        patch.object(settings, "KIND_READER_CACHE_ENABLED", True),
        patch.object(settings, "SERVICE_EXTENSION", "test_extension"),
        patch("importlib.import_module", return_value=extension),
    ):
        reader = _create_reader()

    assert isinstance(reader, CachedKindReader)
    assert isinstance(extension.wrap.call_args.args[0], CachedKindReader)


def test_store_failure_falls_back_to_db():
    class BrokenStore(FakeStore):
        def get(self, key):
            return False, None, None

    reader, base = _make_reader(BrokenStore())
    kind = _make_kind()
    base.get_by_id.return_value = kind

    assert reader.get_by_id(MagicMock(), KindType.BOT, 1) is kind
    assert reader.get_by_id(MagicMock(), KindType.BOT, 1) is kind
    assert base.get_by_id.call_count == 2


class _FakeRedis:
    """Records the exact commands issued by KindCacheStore."""

    def __init__(self):
        self.data = {}
        self.calls = []

    def mget(self, keys):
        self.calls.append(("mget", list(keys)))
        return [self.data.get(key) for key in keys]

    def setex(self, key, ttl, value):
        self.calls.append(("setex", key, ttl))
        self.data[key] = value

    def incr(self, key):
        self.calls.append(("incr", key))
        self.data[key] = str(int(self.data.get(key, 0)) + 1)
        return int(self.data[key])


def test_store_get_many_reads_generation_and_keys_in_one_round_trip():
    store = KindCacheStore()
    store._client = _FakeRedis()
    kind = _make_kind()

    store.set("k1", "0", kind, 300)
    entries, generation = store.get_many(["k1", "k2"])

    assert generation == "0"
    assert list(entries) == ["k1"]
    assert entries["k1"].id == kind.id
    assert store._client.calls == [
        ("setex", "k1", 300),
        ("mget", [_GENERATION_KEY, "k1", "k2"]),
    ]


def test_store_get_many_drops_entries_from_an_older_generation():
    store = KindCacheStore()
    store._client = _FakeRedis()
    store.set("k1", "0", _make_kind(), 300)

    store.bump_generation()
    entries, generation = store.get_many(["k1"])

    assert generation == "1"
    assert entries == {}


def test_cache_hit_returns_a_detached_instance():
    """Write paths must not trust the object returned by a cache hit."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.services.readers.kinds import KindReader

    engine = create_engine("sqlite://")
    Kind.__table__.create(engine)
    db = sessionmaker(bind=engine)()
    db.add(_persisted_kind())
    db.commit()
    team_id = db.query(Kind).one().id

    store = KindCacheStore()
    store._client = _FakeRedis()
    reader = CachedKindReader(KindReader(), store)

    miss = reader.get_by_id(db, KindType.BOT, team_id)
    hit = reader.get_by_id(db, KindType.BOT, team_id)

    assert miss in db
    assert hit not in db
