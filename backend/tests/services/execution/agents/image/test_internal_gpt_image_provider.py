# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.execution.agents.image.providers.internal_gpt_image import (
    InternalGptImageProvider,
)

TEST_MODEL = "gpt-image-2"


class _Response:
    status_code = 200
    text = ""

    def json(self) -> dict:
        return {"data": [{"b64_json": "generated-image"}]}


class _Client:
    def __init__(self) -> None:
        self.post_kwargs = None

    async def __aenter__(self) -> "_Client":
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None

    async def post(self, url: str, **kwargs) -> _Response:
        self.post_kwargs = {"url": url, **kwargs}
        return _Response()


@pytest.fixture
def provider() -> InternalGptImageProvider:
    return InternalGptImageProvider(
        base_url="https://copilot.weibo.com",
        api_key="unused-key",
        model=TEST_MODEL,
        image_config={"size": "1024x1024"},
        default_headers={"x-user-context": "resolved-user"},
    )


@pytest.mark.asyncio
async def test_generate_uses_internal_json_api(
    provider: InternalGptImageProvider,
    monkeypatch,
) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.image.providers.gpt_image.httpx.AsyncClient",
        lambda **kwargs: client,
    )

    await provider.generate("A cat")

    assert (
        client.post_kwargs["url"]
        == "https://copilot.weibo.com/v1/image_generate/openai/images/generations"
    )
    assert client.post_kwargs["headers"] == {
        "Content-Type": "application/json",
        "x-user-context": "resolved-user",
    }
    assert client.post_kwargs["json"]["prompt"] == "A cat"


@pytest.mark.asyncio
async def test_edit_sends_reference_images_in_json(
    provider: InternalGptImageProvider,
    monkeypatch,
) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.image.providers.gpt_image.httpx.AsyncClient",
        lambda **kwargs: client,
    )

    await provider.generate(
        "Edit the image",
        reference_images=["aW1hZ2U="],
    )

    assert (
        client.post_kwargs["url"]
        == "https://copilot.weibo.com/v1/image_generate/openai/images/edits"
    )
    assert client.post_kwargs["json"]["image"] == ["data:image/png;base64,aW1hZ2U="]


def test_factory_builds_internal_provider() -> None:
    from app.services.execution.agents.image.providers import get_image_provider

    result = get_image_provider(
        "internal-gpt-image",
        {
            "base_url": "https://copilot.weibo.com",
            "api_key": "unused-key",
            "model_id": TEST_MODEL,
        },
    )

    assert isinstance(result, InternalGptImageProvider)
