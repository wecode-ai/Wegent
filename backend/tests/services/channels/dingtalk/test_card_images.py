# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import base64
from io import BytesIO

import httpx
import pytest
from PIL import Image

from app.services.channels.dingtalk import card_images


def png_bytes() -> bytes:
    stream = BytesIO()
    Image.new("RGB", (1, 1), color=(255, 255, 255)).save(stream, format="PNG")
    return stream.getvalue()


IMAGE_URLS = [
    "https://static.dingtalk.com/media/example.png",
    "https://down.dingtalk.com/ddmedia/example.png",
]


@pytest.mark.parametrize("url", IMAGE_URLS)
def test_parse_image_urls_accepts_dingtalk_media_and_deduplicates(url):
    assert card_images.parse_image_urls([url, url]) == [url]


@pytest.mark.parametrize(
    "value",
    [
        "https://static.dingtalk.com/media/example.png",
        ["http://static.dingtalk.com/media/example.png"],
        ["https://example.com/media/example.png"],
        ["https://static.dingtalk.com/other/example.png"],
        ["https://static.dingtalk.com/media/example.png#frag"],
        ["http://down.dingtalk.com/ddmedia/example.png"],
        ["https://down.dingtalk.com/media/example.png"],
        ["https://static.dingtalk.com/ddmedia/example.png"],
        ["https://down.dingtalk.com/ddmedia/example.png#frag"],
        ["https://down.dingtalk.com.evil.example/ddmedia/example.png"],
        ["https://down.dingtalk.com@evil.example/ddmedia/example.png"],
        ["https://user@down.dingtalk.com/ddmedia/example.png"],
        ["https://down.dingtalk.com:8443/ddmedia/example.png"],
    ],
)
def test_parse_image_urls_rejects_untrusted_values(value):
    with pytest.raises(ValueError):
        card_images.parse_image_urls(value)


@pytest.mark.asyncio
@pytest.mark.parametrize("url", IMAGE_URLS)
async def test_download_card_images_downloads_verified_png(monkeypatch, url):
    image = png_bytes()
    requests = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            headers={"content-type": "image/png", "content-length": str(len(image))},
            content=image,
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        card_images.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs),
    )

    result = await card_images.download_card_images([url])

    assert result == [
        {
            "mime_type": "image/png",
            "base64_data": base64.b64encode(image).decode("ascii"),
        }
    ]
    assert str(requests[0].url) == url
    assert "authorization" not in requests[0].headers


@pytest.mark.asyncio
@pytest.mark.parametrize("url", IMAGE_URLS)
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(302, headers={"location": "https://example.com/image.png"}),
        httpx.Response(200, headers={"content-type": "text/plain"}, content=b"text"),
        httpx.Response(200, headers={"content-type": "image/png"}, content=b"bad"),
        httpx.Response(404, content=b"missing"),
    ],
)
async def test_download_card_images_rejects_bad_downloads(monkeypatch, response, url):
    async def respond(request: httpx.Request) -> httpx.Response:
        return response

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        card_images.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs),
    )

    with pytest.raises(ValueError):
        await card_images.download_card_images([url])


@pytest.mark.asyncio
async def test_download_card_images_enforces_total_size(monkeypatch):
    image = png_bytes()
    monkeypatch.setattr(card_images, "MAX_TOTAL_BYTES", len(image) + 1)

    async def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "image/png"}, content=image)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        card_images.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs),
    )

    with pytest.raises(ValueError, match="过大"):
        await card_images.download_card_images(
            [
                "https://static.dingtalk.com/media/one.png",
                "https://static.dingtalk.com/media/two.png",
            ]
        )
