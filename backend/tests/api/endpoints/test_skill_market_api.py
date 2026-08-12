# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Optional, cast

import pytest
from fastapi import HTTPException

from app.api.endpoints.skill_market import (
    download_skill,
    list_providers,
    search_skills,
)
from app.models.user import User
from app.services.skill_market import (
    DownloadResult,
    ISkillMarketProvider,
    MarketSkill,
    SearchParams,
    SearchResult,
    skill_market_registry,
)


class StubSkillMarketProvider(ISkillMarketProvider):
    def __init__(self, key: str, name: str) -> None:
        self._key = key
        self._name = name
        self.search_calls: list[SearchParams] = []
        self.download_calls: list[tuple[str, Optional[str]]] = []

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
        self.search_calls.append(params)
        return SearchResult(
            total=1,
            page=params.page,
            pageSize=params.pageSize,
            skills=[
                MarketSkill(
                    skillKey=f"{self.key}_skill",
                    originalSkillKey="skill",
                    name=f"{self.name} Skill",
                    description="Description",
                    author="author",
                    visibility="public",
                )
            ],
        )

    async def download(
        self, skill_key: str, user: Optional[str] = None
    ) -> DownloadResult:
        self.download_calls.append((skill_key, user))
        return DownloadResult(content=self.key.encode(), filename=f"{skill_key}.zip")


@pytest.fixture(autouse=True)
def clear_skill_market_registry() -> Iterator[None]:
    skill_market_registry.clear()
    yield
    skill_market_registry.clear()


def current_user() -> User:
    return cast(User, SimpleNamespace(user_name="alice"))


@pytest.mark.asyncio
async def test_lists_all_registered_providers() -> None:
    skill_market_registry.register(StubSkillMarketProvider("first", "First"))
    skill_market_registry.register(StubSkillMarketProvider("second", "Second"))

    response = await list_providers(current_user=current_user())

    assert [provider.key for provider in response.providers] == ["first", "second"]
    assert [provider.name for provider in response.providers] == ["First", "Second"]


@pytest.mark.asyncio
async def test_search_routes_to_requested_provider() -> None:
    first = StubSkillMarketProvider("first", "First")
    second = StubSkillMarketProvider("second", "Second")
    skill_market_registry.register(first)
    skill_market_registry.register(second)

    response = await search_skills(
        provider="second",
        keyword="docs",
        tags=None,
        page=2,
        pageSize=10,
        current_user=current_user(),
    )

    assert response.skills[0].skillKey == "second_skill"
    assert not first.search_calls
    assert second.search_calls[0].keyword == "docs"
    assert second.search_calls[0].user == "alice"


@pytest.mark.asyncio
async def test_download_routes_to_requested_provider() -> None:
    first = StubSkillMarketProvider("first", "First")
    second = StubSkillMarketProvider("second", "Second")
    skill_market_registry.register(first)
    skill_market_registry.register(second)

    response = await download_skill(
        skill_key="author_skill",
        provider="first",
        current_user=current_user(),
    )

    assert response.body == b"first"
    assert first.download_calls == [("author_skill", "alice")]
    assert not second.download_calls


@pytest.mark.asyncio
async def test_requires_provider_when_multiple_are_registered() -> None:
    skill_market_registry.register(StubSkillMarketProvider("first", "First"))
    skill_market_registry.register(StubSkillMarketProvider("second", "Second"))

    with pytest.raises(HTTPException) as exc_info:
        await search_skills(
            provider=None,
            keyword=None,
            tags=None,
            page=1,
            pageSize=20,
            current_user=current_user(),
        )

    assert exc_info.value.status_code == 400
