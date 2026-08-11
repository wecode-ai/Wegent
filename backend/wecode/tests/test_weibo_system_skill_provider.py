# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

import httpx
import pytest

from wecode.service.system_skill_providers.weibo import (
    DEFAULT_SKILL_HUB_BASE_URL,
    WeiboSkillMarketError,
    WeiboSkillMarketProvider,
)


class FakeAsyncClient:
    responses: list[httpx.Response] = []
    requests: list[dict[str, Any]] = []

    def __init__(self, *, timeout: float) -> None:
        self.timeout = timeout

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        self.requests.append({"url": url, **kwargs})
        return self.responses.pop(0)


@pytest.fixture(autouse=True)
def reset_fake_client(monkeypatch):
    FakeAsyncClient.responses = []
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        "wecode.service.system_skill_providers.weibo.httpx.AsyncClient",
        FakeAsyncClient,
    )
    for name in (
        "SKILL_HUB_BASE_URL",
        "MCP_TOKEN",
        "WEGENT_SKILL_IDENTITY_TOKEN",
        "WEIBO_SKILL_MARKET_BASE_URL",
        "WEIBO_SKILL_MARKET_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)


def response(status_code: int, *, json: Any = None, content: bytes = b""):
    request = httpx.Request("GET", "https://skill-hub.example.test")
    return httpx.Response(
        status_code,
        json=json,
        content=content if json is None else None,
        request=request,
    )


def test_provider_uses_default_configuration():
    provider = WeiboSkillMarketProvider()

    config = provider.get_config()

    assert config.key == "weibo"
    assert config.requires_token is False
    assert provider._get_base_url() == DEFAULT_SKILL_HUB_BASE_URL


def test_provider_configuration_prefers_primary_environment_variables(monkeypatch):
    monkeypatch.setenv("WEIBO_SKILL_MARKET_BASE_URL", "https://legacy.example.test")
    monkeypatch.setenv("SKILL_HUB_BASE_URL", "https://primary.example.test")
    monkeypatch.setenv("WEIBO_SKILL_MARKET_TOKEN", "legacy-token")
    monkeypatch.setenv("MCP_TOKEN", "primary-token")
    provider = WeiboSkillMarketProvider()

    assert provider._get_base_url() == "https://primary.example.test"
    assert provider._get_token() == "primary-token"


def test_provider_requires_server_token():
    with pytest.raises(WeiboSkillMarketError) as exc_info:
        WeiboSkillMarketProvider()._get_token()

    assert exc_info.value.code == "token_required"


@pytest.mark.anyio
async def test_provider_fetches_and_maps_skill_hub_items(monkeypatch):
    monkeypatch.setenv("SKILL_HUB_BASE_URL", "https://skill-hub.example.test/")
    monkeypatch.setenv("MCP_TOKEN", "secret-token")
    FakeAsyncClient.responses = [
        response(
            200,
            json={
                "code": 0,
                "data": {
                    "total": 1,
                    "page": 2,
                    "pageSize": 10,
                    "skills": [
                        {
                            "skillKey": "alice_hot-search",
                            "originalSkillKey": "hot-search",
                            "name": "Hot Search",
                            "description": "Read Weibo hot searches",
                            "tags": ["weibo", "search"],
                            "currentVersion": 3,
                            "author": "Alice",
                            "hasDownloadPermission": False,
                            "updatedAt": "2026-06-09T08:00:00Z",
                        }
                    ],
                },
            },
        )
    ]

    result = await WeiboSkillMarketProvider().fetch_skills(
        keyword="hot",
        tags=["weibo", "search"],
        page=2,
        page_size=10,
    )

    assert result.total == 1
    assert result.page == 2
    assert result.page_size == 10
    assert result.items[0].id == "@weibo/alice_hot-search"
    assert result.items[0].name == "hot-search"
    assert result.items[0].displayName == "Hot Search"
    assert result.items[0].version == "3"
    assert result.items[0].requiresPermission is True
    assert FakeAsyncClient.requests == [
        {
            "url": "https://skill-hub.example.test/2/api/skills/list",
            "params": {
                "page": 2,
                "pageSize": 10,
                "keyword": "hot",
                "tags": "weibo,search",
            },
            "headers": {"Authorization": "Bearer secret-token"},
        }
    ]


@pytest.mark.anyio
async def test_provider_maps_skill_hub_error():
    FakeAsyncClient.responses = [
        response(200, json={"code": 401, "message": "Token expired"})
    ]

    with pytest.raises(WeiboSkillMarketError) as exc_info:
        await WeiboSkillMarketProvider().fetch_skills(
            keyword=None,
            tags=None,
            page=1,
            page_size=20,
            token="expired-token",
        )

    assert exc_info.value.code == "unauthorized"
    assert str(exc_info.value) == "Token expired"


@pytest.mark.anyio
async def test_provider_downloads_requested_version(monkeypatch):
    monkeypatch.setenv("SKILL_HUB_BASE_URL", "https://skill-hub.example.test")
    monkeypatch.setenv("MCP_TOKEN", "secret-token")
    FakeAsyncClient.responses = [response(200, content=b"skill archive")]

    content = await WeiboSkillMarketProvider().download_skill(
        source_skill_key="alice_hot-search",
        version="1.2.0",
    )

    assert content == b"skill archive"
    assert FakeAsyncClient.requests == [
        {
            "url": (
                "https://skill-hub.example.test/2/api/skills/"
                "alice_hot-search/download/1.2.0"
            ),
            "headers": {"Authorization": "Bearer secret-token"},
        }
    ]
