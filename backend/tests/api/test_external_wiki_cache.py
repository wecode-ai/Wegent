# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the wiki page-list cache helpers (design §5.6 P1)."""

from types import SimpleNamespace

import pytest
from sqlalchemy import inspect
from sqlalchemy.orm import sessionmaker

from app.api.endpoints import external_wiki
from app.models.user import User


class FakeCache:
    def __init__(self):
        self.store: dict = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, expire=None):
        self.store[key] = value
        return True

    async def delete(self, key):
        return self.store.pop(key, None) is not None


@pytest.mark.asyncio
async def test_cached_page_list_serves_second_call_from_cache(monkeypatch):
    fake = FakeCache()
    monkeypatch.setattr(external_wiki, "cache_manager", fake)
    calls = []

    async def fetch_all():
        calls.append(1)
        return ([{"path": "docs/a"}], ["warn"])

    first, warnings = await external_wiki._cached_page_list(
        "kb:1", None, False, fetch_all
    )
    assert first == [{"path": "docs/a"}]
    assert warnings == ["warn"]

    second, warnings = await external_wiki._cached_page_list(
        "kb:1", None, False, fetch_all
    )
    assert second == [{"path": "docs/a"}]
    assert warnings == ["warn"]
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_cached_page_list_refresh_bypasses_cache(monkeypatch):
    fake = FakeCache()
    monkeypatch.setattr(external_wiki, "cache_manager", fake)
    calls = []

    async def fetch_all():
        calls.append(1)
        return ([{"path": "docs/a"}], [])

    await external_wiki._cached_page_list("kb:1", None, False, fetch_all)
    await external_wiki._cached_page_list("kb:1", None, True, fetch_all)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_cached_page_list_caches_empty_results(monkeypatch):
    fake = FakeCache()
    monkeypatch.setattr(external_wiki, "cache_manager", fake)
    calls = []

    async def fetch_all():
        calls.append(1)
        return ([], [])

    first, _ = await external_wiki._cached_page_list("kb:empty", None, False, fetch_all)
    second, _ = await external_wiki._cached_page_list(
        "kb:empty", None, False, fetch_all
    )

    assert first == second == []
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_locales_use_independent_cache_keys(monkeypatch):
    fake = FakeCache()
    monkeypatch.setattr(external_wiki, "cache_manager", fake)

    async def fetch_default():
        return ([{"path": "a"}], [])

    async def fetch_zh():
        return ([{"path": "z"}], [])

    await external_wiki._cached_page_list("kb:1", None, False, fetch_default)
    await external_wiki._cached_page_list("kb:1", "zh", False, fetch_zh)
    assert set(fake.store) == {
        "wiki:pages:kb:1:locale:_default",
        "wiki:pages:kb:1:locale:zh",
    }


def test_filter_and_slice_prefix_and_pagination():
    items = [{"path": p} for p in ["docs/a", "docs/sub/b", "ops/c"]]
    batch, next_offset = external_wiki._filter_and_slice(items, "docs", 1, 0)
    assert [item["path"] for item in batch] == ["docs/a"]
    assert next_offset == 1

    batch, next_offset = external_wiki._filter_and_slice(items, None, 2, 2)
    assert [item["path"] for item in batch] == ["ops/c"]
    assert next_offset is None  # last partial page: no further batch

    # Prefix matching must not leak sibling directories (docs/arch vs docs).
    batch, _ = external_wiki._filter_and_slice(
        items + [{"path": "docs-arch/x"}], "docs", 10, 0
    )
    assert [item["path"] for item in batch] == ["docs/a", "docs/sub/b"]


@pytest.mark.asyncio
async def test_list_pages_keeps_current_user_attached_across_remote_io(
    monkeypatch, test_db, test_user
):
    """Production sessions expire ORM attributes on commit."""
    production_session = sessionmaker(bind=test_db.get_bind(), expire_on_commit=True)()
    current_user = production_session.get(User, test_user.id)
    assert current_user is not None

    class Connector:
        async def list_pages(self, *_args, **_kwargs):
            assert not production_session.in_transaction()
            return [], None

    connection = SimpleNamespace(
        connection_id="conn-primary",
        revision=1,
        connector=Connector(),
        config=SimpleNamespace(),
    )
    monkeypatch.setattr(
        external_wiki.WikiConnectionService,
        "get_user_wiki_connection",
        lambda *_args, **_kwargs: connection,
    )
    fake_cache = FakeCache()
    monkeypatch.setattr(external_wiki, "cache_manager", fake_cache)

    try:
        response = await external_wiki.list_wiki_pages(
            path=None,
            locale=None,
            limit=50,
            offset=0,
            refresh=False,
            connection_id="conn-primary",
            db=production_session,
            current_user=current_user,
        )
        assert response.pages == []
        assert set(fake_cache.store) == {
            f"wiki:pages:user:{test_user.id}:conn-primary:revision:1:locale:_default"
        }
        assert inspect(current_user).detached is False
    finally:
        production_session.close()
