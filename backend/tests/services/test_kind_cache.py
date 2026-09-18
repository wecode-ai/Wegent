# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Redis-backed Kind reader cache."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services.readers.kind_cache import (
    _MISS_SENTINEL,
    CachedKindReader,
    _kind_from_payload,
    _kind_to_payload,
)
from app.services.readers.kinds import KindType


class FakeStore:
    """In-memory stand-in for KindCacheStore."""

    def __init__(self):
        self.data = {}

    def get(self, key):
        if key not in self.data:
            return False, None
        return True, self.data[key]

    def set(self, key, kind, ttl):
        self.data[key] = kind

    def delete(self, *keys):
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

    db = MagicMock()
    first = reader.get_by_ids(db, KindType.BOT, [1, 2, 3])
    second = reader.get_by_ids(db, KindType.BOT, [1, 2, 3])

    assert [k.id for k in first] == [1, 2, 3]
    assert [k.id for k in second] == [1, 2, 3]
    assert base.get_by_id.call_count == 3


def test_get_by_ids_empty():
    store = FakeStore()
    reader, base = _make_reader(store)
    assert reader.get_by_ids(MagicMock(), KindType.BOT, []) == []
    base.get_by_id.assert_not_called()


def test_on_change_evicts_all_variants():
    store = FakeStore()
    reader, base = _make_reader(store)
    db = MagicMock()
    base.get_by_id.return_value = _make_kind()
    base.get_personal.return_value = _make_kind()
    base.get_public.return_value = _make_kind(user_id=0)
    base.get_group.return_value = _make_kind(namespace="team-ns")

    reader.get_by_id(db, KindType.BOT, 1)
    reader.get_personal(db, 10, KindType.BOT, "default", "mybot")
    reader.get_public(db, KindType.BOT, "default", "mybot")
    reader.get_group(db, KindType.BOT, "default", "mybot")
    assert len(store.data) == 4

    reader.on_change(KindType.BOT, 1, 10, "default", "mybot")
    assert store.data == {}


def test_on_change_accepts_raw_kind_string():
    store = FakeStore()
    reader, _ = _make_reader(store)
    # Custom kinds not covered by KindType must not raise.
    reader.on_change("Device", 1, 10, "default", "dev")


def test_store_failure_falls_back_to_db():
    class BrokenStore(FakeStore):
        def get(self, key):
            return False, None

        def set(self, key, kind, ttl):
            pass

    reader, base = _make_reader(BrokenStore())
    kind = _make_kind()
    base.get_by_id.return_value = kind

    assert reader.get_by_id(MagicMock(), KindType.BOT, 1) is kind
    base.get_by_id.assert_called_once()
