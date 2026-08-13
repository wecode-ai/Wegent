# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from app.services.skill_market.provider import (
    DownloadResult,
    ISkillMarketProvider,
    SearchParams,
    SearchResult,
    SkillMarketProviderRegistry,
)


class StubSkillMarketProvider(ISkillMarketProvider):
    def __init__(self, key: str, name: str) -> None:
        self._key = key
        self._name = name

    @property
    def key(self) -> str:
        return self._key

    @property
    def name(self) -> str:
        return self._name

    @property
    def market_url(self) -> str:
        return f"https://example.com/{self.key}"

    async def search(self, params: SearchParams) -> SearchResult:
        return SearchResult(total=0, page=params.page, pageSize=params.pageSize)

    async def download(
        self, skill_key: str, user: Optional[str] = None
    ) -> DownloadResult:
        return DownloadResult(content=b"skill", filename=f"{skill_key}.zip")


def test_registry_keeps_multiple_providers_in_registration_order() -> None:
    registry = SkillMarketProviderRegistry()
    first = StubSkillMarketProvider("first", "First")
    second = StubSkillMarketProvider("second", "Second")

    registry.register(first)
    registry.register(second)

    assert registry.list_providers() == [first, second]
    assert registry.get_provider("first") is first
    assert registry.get_provider("second") is second
    assert registry.get_single_provider() is None


def test_registry_replaces_only_matching_provider_key() -> None:
    registry = SkillMarketProviderRegistry()
    original = StubSkillMarketProvider("first", "Original")
    replacement = StubSkillMarketProvider("first", "Replacement")
    second = StubSkillMarketProvider("second", "Second")

    registry.register(original)
    registry.register(second)
    registry.register(replacement)

    assert registry.list_providers() == [replacement, second]
    assert registry.get_provider("first") is replacement
    assert registry.get_single_provider() is None


def test_registry_returns_single_provider_for_legacy_clients() -> None:
    registry = SkillMarketProviderRegistry()
    provider = StubSkillMarketProvider("only", "Only")

    registry.register(provider)

    assert registry.get_single_provider() is provider
