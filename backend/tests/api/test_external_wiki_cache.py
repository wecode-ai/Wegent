# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the wiki page-list cache helpers (design §5.6 P1)."""

import pytest

from app.api.endpoints import external_wiki


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
    assert warnings == []
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
async def test_locale_buckets_share_one_key(monkeypatch):
    fake = FakeCache()
    monkeypatch.setattr(external_wiki, "cache_manager", fake)

    async def fetch_default():
        return ([{"path": "a"}], [])

    async def fetch_zh():
        return ([{"path": "z"}], [])

    await external_wiki._cached_page_list("kb:1", None, False, fetch_default)
    await external_wiki._cached_page_list("kb:1", "zh", False, fetch_zh)
    bucket = fake.store["wiki:pages:kb:1"]
    assert set(bucket.keys()) == {"", "zh"}
    # One delete invalidates every locale variant at once.
    await external_wiki._invalidate_kb_pages_cache(1)
    assert "wiki:pages:kb:1" not in fake.store


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
