# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64

import pytest

from app.services.execution.agents.image.providers.gpt_image import GptImageProvider
from app.services.web_scraper.security import WebScraperSecurityError

TEST_MODEL = "gpt-image-2"


class _Response:
    def __init__(self, data: dict, status_code: int = 200):
        self._data = data
        self.status_code = status_code
        self.text = str(data)

    def json(self) -> dict:
        return self._data


class _Client:
    def __init__(self, response: _Response) -> None:
        self.response = response
        self.post_kwargs = None

    async def __aenter__(self) -> "_Client":
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None

    async def post(self, url: str, **kwargs) -> _Response:
        self.post_kwargs = {"url": url, **kwargs}
        return self.response


def _image_response(status_code: int = 200) -> _Response:
    return _Response(
        {
            "data": [{"b64_json": "generated-image"}],
            "size": "1024x1024",
        },
        status_code=status_code,
    )


def test_request_log_params_excludes_prompt_and_reference_contents() -> None:
    params = GptImageProvider._request_log_params(
        {
            "model": TEST_MODEL,
            "prompt": "private prompt",
            "size": "1512x648",
            "n": 1,
            "image": ["data:image/png;base64,private-image"],
        }
    )

    assert params == {
        "model": TEST_MODEL,
        "n": 1,
        "size": "1512x648",
        "reference_image_count": 1,
    }


@pytest.mark.asyncio
async def test_remote_reference_rejects_unsafe_url(monkeypatch) -> None:
    def reject_url(self, url: str) -> None:
        raise WebScraperSecurityError("ssrf_blocked", "blocked")

    monkeypatch.setattr(
        "app.services.execution.agents.image.providers.gpt_image."
        "WebScraperUrlGuard.validate_initial_url",
        reject_url,
    )

    with pytest.raises(WebScraperSecurityError, match="blocked"):
        await GptImageProvider._load_reference_image(
            object(),
            "http://127.0.0.1/private.png",
        )


@pytest.fixture
def provider() -> GptImageProvider:
    return GptImageProvider(
        base_url="https://xxxxx.com/v1",
        api_key="test-key",
        model=TEST_MODEL,
        image_config={
            "size": "1024x1024",
            "max_images": 2,
            "quality": "high",
            "output_format": "png",
            "output_compression": 80,
            "background": "transparent",
            "moderation": "low",
        },
    )


@pytest.mark.asyncio
async def test_generate_uses_openai_images_api(
    provider: GptImageProvider, monkeypatch
) -> None:
    client = _Client(_image_response())
    monkeypatch.setattr(
        "app.services.execution.agents.image.providers.gpt_image.httpx.AsyncClient",
        lambda **kwargs: client,
    )

    result = await provider.generate("A cat")

    assert client.post_kwargs["url"] == "https://xxxxx.com/v1/images/generations"
    assert client.post_kwargs["headers"] == {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-key",
    }
    assert client.post_kwargs["json"] == {
        "model": TEST_MODEL,
        "prompt": "A cat",
        "n": 2,
        "size": "1024x1024",
        "quality": "high",
        "output_format": "png",
        "output_compression": 80,
        "background": "transparent",
        "moderation": "low",
    }
    assert result.images[0].b64_json == "generated-image"


@pytest.mark.asyncio
async def test_generate_exposes_openai_error(
    provider: GptImageProvider, monkeypatch
) -> None:
    client = _Client(
        _Response(
            {"error": {"message": "upstream failed"}},
            status_code=500,
        )
    )
    monkeypatch.setattr(
        "app.services.execution.agents.image.providers.gpt_image.httpx.AsyncClient",
        lambda **kwargs: client,
    )

    with pytest.raises(RuntimeError, match="upstream failed"):
        await provider.generate("A cat")


@pytest.mark.asyncio
async def test_generate_with_references_uses_image_edits(
    provider: GptImageProvider, monkeypatch
) -> None:
    client = _Client(_image_response())
    monkeypatch.setattr(
        "app.services.execution.agents.image.providers.gpt_image.httpx.AsyncClient",
        lambda **kwargs: client,
    )

    await provider.generate(
        "Edit the image",
        reference_images=[
            "data:image/png;base64,aW1hZ2U=",
            "aW1hZ2U=",
        ],
    )

    assert client.post_kwargs["url"] == "https://xxxxx.com/v1/images/edits"
    assert client.post_kwargs["data"]["prompt"] == "Edit the image"
    assert client.post_kwargs["data"]["model"] == TEST_MODEL
    assert client.post_kwargs["files"] == [
        ("image[]", ("reference-1.png", b"image", "image/png")),
        ("image[]", ("reference-2.png", b"image", "image/png")),
    ]
    assert client.post_kwargs["headers"] == {
        "Authorization": "Bearer test-key",
    }


def test_requires_base_url() -> None:
    with pytest.raises(ValueError, match="requires base_url"):
        GptImageProvider(
            base_url=None,
            api_key="test-key",
            model=TEST_MODEL,
        )


def test_requires_model() -> None:
    with pytest.raises(ValueError, match="requires model"):
        GptImageProvider(
            base_url="https://api.openai.com/v1",
            api_key="test-key",
            model=None,
        )


def test_builds_auth_and_default_headers() -> None:
    provider = GptImageProvider(
        base_url="https://gateway.example.com/v1/",
        api_key="test-key",
        model=TEST_MODEL,
        default_headers={"x-user-context": "resolved-user"},
    )

    assert provider.base_url == "https://gateway.example.com/v1"
    assert provider._request_headers() == {
        "Content-Type": "application/json",
        "x-user-context": "resolved-user",
        "Authorization": "Bearer test-key",
    }


def test_factory_builds_gpt_image_provider() -> None:
    from app.services.execution.agents.image.providers import get_image_provider

    result = get_image_provider(
        "gpt-image",
        {
            "base_url": "https://xxxxx.com",
            "api_key": "test-key",
            "model_id": TEST_MODEL,
            "imageConfig": {"size": "1024x1024"},
        },
    )

    assert isinstance(result, GptImageProvider)
    assert result.model == TEST_MODEL
