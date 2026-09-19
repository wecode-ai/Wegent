# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Redis-backed Kind reader cache."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.models.kind import Kind
from app.services.readers.kind_cache import (
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
        self.mget_calls = 0
        self.set_calls = 0
        self.delete_calls = 0

    def get_many(self, keys):
        self.mget_calls += 1
        entries = {}
        for key in keys:
            if key in self.data:
                entries[key] = self.data[key]
        return entries, True

    def get(self, key):
        entries, available = self.get_many([key])
        return key in entries, entries.get(key)

    def set(self, key, kind, ttl, *, overwrite=True):
        self.set_calls += 1
        self.data[key] = kind

    def delete(self, *keys):
        self.delete_calls += 1
        for key in keys:
            self.data.pop(key, None)


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


def _persisted_kind(name="mybot"):
    return Kind(
        user_id=10,
        kind=KindType.BOT.value,
        name=name,
        namespace="default",
        json={"kind": "Bot"},
        is_active=True,
    )


def _make_session():
    engine = create_engine("sqlite://")
    Kind.__table__.create(engine)
    factory = sessionmaker(bind=engine)
    install_kind_change_listener(factory)
    return factory()


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


def test_get_by_ids_uses_one_batch_load_and_populates_cache():
    store = FakeStore()
    reader, base = _make_reader(store)
    base.get_by_ids.side_effect = lambda db, kind, rids: [
        _make_kind(kind_id=rid) for rid in rids
    ]

    db = MagicMock()
    first = reader.get_by_ids(db, KindType.BOT, [1, 2, 3])
    second = reader.get_by_ids(db, KindType.BOT, [1, 2, 3])

    assert [k.id for k in first] == [1, 2, 3]
    assert [k.id for k in second] == [1, 2, 3]
    base.get_by_ids.assert_called_once()
    base.get_by_id.assert_not_called()
    assert store.mget_calls == 2


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


def test_on_change_delegates_to_base():
    store = FakeStore()
    reader, base = _make_reader(store)

    reader.on_change(KindType.BOT, 1, 10, "default", "mybot")

    base.on_change.assert_called_once_with(KindType.BOT, 1, 10, "default", "mybot")


def test_orm_insert_writes_through_after_commit():
    store = FakeStore()
    session = _make_session()

    with patch("app.services.readers.kind_cache._write_through_store", store):
        session.add(_persisted_kind())
        session.commit()

    assert store.set_calls >= 1
    assert store.delete_calls == 0
    session.close()


def test_orm_update_writes_through_after_commit():
    store = FakeStore()
    session = _make_session()

    with patch("app.services.readers.kind_cache._write_through_store", store):
        session.add(_persisted_kind())
        session.commit()
        store.data.clear()
        store.set_calls = 0

        row = session.query(Kind).one()
        row.json = {"kind": "Bot", "updated": True}
        session.commit()

    assert store.set_calls >= 1
    session.close()


def test_orm_delete_evicts_keys_after_commit():
    store = FakeStore()
    session = _make_session()

    with patch("app.services.readers.kind_cache._write_through_store", store):
        session.add(_persisted_kind())
        session.commit()
        store.data.clear()
        store.set_calls = 0
        store.delete_calls = 0

        row = session.query(Kind).one()
        session.delete(row)
        session.commit()

    assert store.delete_calls >= 1
    assert store.data == {}
    session.close()


def test_rename_deletes_old_key_and_sets_new_key():
    store = FakeStore()
    session = _make_session()

    with patch("app.services.readers.kind_cache._write_through_store", store):
        session.add(_persisted_kind(name="old-name"))
        session.commit()
        store.data.clear()
        store.set_calls = 0
        store.delete_calls = 0

        row = session.query(Kind).one()
        row.name = "new-name"
        session.commit()

    assert store.delete_calls >= 1
    assert store.set_calls >= 1
    session.close()


def test_bulk_update_is_flagged_for_ttl_fallback():
    store = FakeStore()
    session = _make_session()

    with patch("app.services.readers.kind_cache._write_through_store", store):
        session.add(_persisted_kind())
        session.commit()
        store.data.clear()
        store.set_calls = 0
        store.delete_calls = 0

        session.query(Kind).filter(Kind.name == "mybot").update({"user_id": 20})
        session.commit()

    # Bulk statements bypass the ORM unit of work, so there is nothing to
    # write back; the TTL is the staleness bound for this path.
    assert store.set_calls == 0
    assert store.delete_calls == 0
    session.close()


def test_rollback_does_not_write_to_cache():
    store = FakeStore()
    session = _make_session()

    with patch("app.services.readers.kind_cache._write_through_store", store):
        session.add(_persisted_kind())
        session.rollback()

    assert store.set_calls == 0
    assert store.delete_calls == 0
    session.close()


def test_keys_for_identity_follows_valid_scope():
    from app.services.readers.kind_cache import _keys_for_identity, _prefix

    personal = _keys_for_identity(
        {"kind": "Bot", "user_id": 10, "namespace": "default", "name": "b"}
    )
    public = _keys_for_identity(
        {"kind": "Bot", "user_id": 0, "namespace": "default", "name": "b"}
    )
    group = _keys_for_identity(
        {"kind": "Bot", "user_id": 10, "namespace": "team-ns", "name": "b"}
    )

    assert personal == [f"{_prefix()}personal:Bot:10:default:b"]
    assert public == [f"{_prefix()}public:Bot:default:b"]
    assert group == [f"{_prefix()}group:Bot:team-ns:b"]


def test_multi_flush_snapshot_keeps_earliest_identity():
    store = FakeStore()
    session = _make_session()

    with patch("app.services.readers.kind_cache._write_through_store", store):
        session.add(_persisted_kind(name="first"))
        session.commit()
        store.data.clear()
        store.set_calls = 0
        store.delete_calls = 0

        row = session.query(Kind).one()
        row.name = "intermediate"
        session.flush()
        row.name = "final"
        session.commit()

    # The key for the original name must be evicted, not just the
    # intermediate one.
    assert store.delete_calls >= 1
    assert store.set_calls >= 1
    session.close()


def test_dirty_row_is_not_written_to_cache():
    store = FakeStore()
    session = _make_session()
    session.add(_persisted_kind())
    session.commit()

    reader, base = _make_reader(store)
    row = session.query(Kind).one()
    base.get_by_id.return_value = row

    row.json = {"uncommitted": True}  # pending change in this session
    assert reader.get_by_id(session, KindType.BOT, row.id) is row
    assert store.set_calls == 0
    session.close()


def test_flushed_but_uncommitted_row_is_not_cached():
    """An explicit flush must not leak uncommitted rows into the cache."""
    store = FakeStore()
    session = _make_session()
    session.add(_persisted_kind())
    session.commit()

    reader, base = _make_reader(store)
    row = session.query(Kind).one()

    row.json = {"flushed": True}
    session.flush()  # snapshot recorded, row looks clean to is_modified
    base.get_by_id.return_value = row

    assert reader.get_by_id(session, KindType.BOT, row.id) is row
    assert store.set_calls == 0

    session.rollback()
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
        def get_many(self, keys):
            return {}, False

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

    def set(self, key, value, ex=None, nx=False):
        self.calls.append(("set", key, ex, nx))
        if nx and key in self.data:
            return None
        self.data[key] = value
        return True

    def delete(self, *keys):
        self.calls.append(("delete", list(keys)))
        for key in keys:
            self.data.pop(key, None)


def test_store_get_many_reads_keys_in_one_round_trip():
    store = KindCacheStore()
    store._client = _FakeRedis()
    kind = _make_kind()

    store.set("k1", kind, 300)
    entries, available = store.get_many(["k1", "k2"])

    assert available is True
    assert list(entries) == ["k1"]
    assert entries["k1"].id == kind.id
    assert store._client.calls == [
        ("setex", "k1", 300),
        ("mget", ["k1", "k2"]),
    ]


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
    kind_id = db.query(Kind).one().id

    store = KindCacheStore()
    store._client = _FakeRedis()
    reader = CachedKindReader(KindReader(), store)

    miss = reader.get_by_id(db, KindType.BOT, kind_id)
    hit = reader.get_by_id(db, KindType.BOT, kind_id)

    assert miss in db
    assert hit not in db
