# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for repository-resolution cache isolation."""

from app.services.knowledge.code_wiki import resolution
from app.services.knowledge.code_wiki.resolution import resolve_repository
from app.services.knowledge.code_wiki.source import SourceRepository

PRIVATE = {
    "visibility": "private",
    "default_branch": "main",
    "name": "secret/repository",
    "description": "private metadata",
}
PUBLIC = {
    "visibility": "public",
    "default_branch": "main",
    "name": "wecode-ai/Wegent",
    "description": "public metadata",
}


class InMemoryCache:
    def __init__(self):
        self.entries: dict[str, dict] = {}

    async def get(self, key: str):
        return self.entries.get(key)

    async def set(self, key: str, value: dict, *, expire: int):
        self.entries[key] = value


class RecordingProvider:
    def __init__(self, responses: dict[str, dict | None]):
        self.responses = responses
        self.tokens: list[str] = []

    def describe_repository(self, *, token: str, **_):
        self.tokens.append(token)
        return self.responses.get(token)


def _source() -> SourceRepository:
    return SourceRepository.from_url(
        "github", "https://github.com/wecode-ai/Wegent.git"
    )


def test_authenticated_resolution_cache_is_isolated_by_user(
    monkeypatch,
):
    cache = InMemoryCache()
    provider = RecordingProvider({"token-owner": PRIVATE, "token-other": None})
    monkeypatch.setattr(resolution, "cache_manager", cache)
    monkeypatch.setattr(
        resolution,
        "get_user_git_info",
        lambda *, user_id, **_: (
            {"token": "token-owner"} if user_id == 1 else {"token": "token-other"}
        ),
    )
    monkeypatch.setattr(resolution, "provider_for", lambda _: provider)

    owner = resolve_repository(db=None, user_id=1, source=_source())
    other = resolve_repository(db=None, user_id=2, source=_source())

    assert owner.exists is True
    assert other.exists is False
    assert provider.tokens == ["token-owner", "token-other"]
    assert all("token-owner" not in key for key in cache.entries)
    assert all("token-other" not in key for key in cache.entries)


def test_anonymous_public_resolution_cache_remains_shared(monkeypatch):
    cache = InMemoryCache()
    provider = RecordingProvider({"": PUBLIC})
    monkeypatch.setattr(resolution, "cache_manager", cache)
    monkeypatch.setattr(resolution, "get_user_git_info", lambda **_: None)
    monkeypatch.setattr(resolution, "provider_for", lambda _: provider)

    first = resolve_repository(db=None, user_id=1, source=_source())
    second = resolve_repository(db=None, user_id=2, source=_source())

    assert first.exists is True
    assert second.exists is True
    assert provider.tokens == [""]
    assert len(cache.entries) == 1
