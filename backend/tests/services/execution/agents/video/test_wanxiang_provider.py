# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.execution.agents.video.providers import get_video_provider
from app.services.execution.agents.video.providers.wanxiang import WanxiangProvider


class _Response:
    status_code = 200
    text = ""

    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class _Client:
    def __init__(self):
        self.post_kwargs = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def post(self, url, **kwargs):
        self.post_kwargs = {"url": url, **kwargs}
        return _Response({"output": {"task_id": "happyhorse-job-1"}})


def test_factory_builds_happyhorse_provider() -> None:
    provider = get_video_provider(
        "wanxiang",
        {
            "base_url": "https://example.com",
            "api_key": "test-key",
            "model_id": "happyhorse-1.0",
            "videoConfig": {"duration": 10},
        },
    )

    assert isinstance(provider, WanxiangProvider)
    assert provider.model_id == "happyhorse-1.0"


@pytest.mark.asyncio
async def test_happyhorse_text_prompt_uses_t2v_payload(monkeypatch) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.wanxiang.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = WanxiangProvider(
        base_url="https://example.com",
        api_key="test-key",
        model_id="happyhorse-1.0",
        video_config={"resolution": "720p", "duration": 10, "ratio": "9:16"},
    )

    job_id = await provider.create_job("一匹马奔跑在草原上")

    assert job_id == "happyhorse-job-1"
    assert client.post_kwargs["json"] == {
        "model": "happyhorse-1.0-t2v",
        "input": {"prompt": "一匹马奔跑在草原上"},
        "parameters": {
            "resolution": "720P",
            "watermark": False,
            "duration": 10,
            "ratio": "9:16",
        },
    }


@pytest.mark.asyncio
async def test_happyhorse_reference_images_use_r2v_payload(monkeypatch) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.wanxiang.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = WanxiangProvider(
        base_url="https://example.com",
        api_key="test-key",
        model_id="happyhorse-1.0",
    )

    await provider.create_job(
        "让角色挥手",
        reference_images=[{"url": "https://cdn.example.com/character.png"}],
    )

    payload = client.post_kwargs["json"]
    assert payload["model"] == "happyhorse-1.0-r2v"
    assert payload["input"]["media"] == [
        {
            "type": "reference_image",
            "url": "https://cdn.example.com/character.png",
        }
    ]
