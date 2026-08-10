# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.execution.agents.video.providers import get_video_provider
from app.services.execution.agents.video.providers.seedance import SeedanceProvider


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
        self.get_kwargs = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def post(self, url, **kwargs):
        self.post_kwargs = {"url": url, **kwargs}
        return _Response({"id": "job-1"})

    async def get(self, url, **kwargs):
        self.get_kwargs = {"url": url, **kwargs}
        return _Response({"status": "running", "progress": 0})


def test_factory_does_not_override_default_model_with_none() -> None:
    provider = get_video_provider(
        "seedance",
        {
            "base_url": "https://example.com",
            "api_key": "test-key",
            "videoConfig": {},
        },
    )

    assert "model" not in provider.video_config


@pytest.mark.asyncio
async def test_seedance_passes_resolved_headers_without_query_params(
    monkeypatch,
) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = SeedanceProvider(
        base_url="https://example.com",
        api_key="test-key",
        video_config={"model": "seedance-test"},
        default_headers={"x-user-context": "resolved-user"},
    )

    await provider.create_job(prompt="Generate a video")
    await provider.get_status("job-1")

    assert "params" not in client.post_kwargs
    assert "params" not in client.get_kwargs
    assert client.post_kwargs["headers"]["x-user-context"] == "resolved-user"
    assert client.get_kwargs["headers"]["x-user-context"] == "resolved-user"


@pytest.mark.asyncio
async def test_seedance_leaves_missing_progress_for_poller_estimation(
    monkeypatch,
) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = SeedanceProvider(
        base_url="https://example.com",
        api_key="test-key",
    )

    status = await provider.get_status("job-1")

    assert status.progress == 0


@pytest.mark.asyncio
async def test_seedance_assigns_extra_images_as_references(monkeypatch) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = SeedanceProvider(
        base_url="https://example.com",
        api_key="test-key",
        video_config={"model": "seedance-test"},
    )

    await provider.create_job(
        prompt="Generate a video",
        image_mode="first_frame",
        reference_images=[
            {"url": "https://example.com/first.png"},
            {"url": "https://example.com/last.png"},
            {"url": "https://example.com/reference.png"},
        ],
    )

    image_content = client.post_kwargs["json"]["content"][1:]
    assert [item["role"] for item in image_content] == [
        "first_frame",
        "last_frame",
        "reference_image",
    ]
