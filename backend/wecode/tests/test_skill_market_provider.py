# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.services.skill_market.provider import SearchParams
from wecode.service.skill_market.weibo_provider import WeiboSkillMarketProvider


class FakeAsyncClient:
    requests: list[str] = []

    def __init__(self, timeout: float) -> None:
        self.timeout = timeout

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def get(self, url: str, headers: dict[str, str]) -> httpx.Response:
        self.requests.append(url)
        return httpx.Response(
            200,
            json={
                "code": 0,
                "data": {
                    "total": 0,
                    "page": 1,
                    "pageSize": 20,
                    "skills": [],
                },
            },
        )


def test_market_url_opens_skill_hub() -> None:
    assert (
        WeiboSkillMarketProvider().market_url
        == "https://mcp.intra.weibo.com/pages/skills"
    )


@pytest.mark.asyncio
async def test_search_defaults_to_download_count_sort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        "wecode.service.skill_market.weibo_provider.httpx.AsyncClient",
        FakeAsyncClient,
    )
    monkeypatch.setenv("WEIBO_MCP_SYSTEM_TOKEN", "token")

    await WeiboSkillMarketProvider().search(SearchParams(page=1, pageSize=20))

    query = parse_qs(urlparse(FakeAsyncClient.requests[0]).query)
    assert query["sortBy"] == ["download_count"]
