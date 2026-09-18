# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Adapt the card UploadImage URL array to the existing IM image format."""

import base64
from urllib.parse import urlsplit

import httpx

from shared.telemetry.decorators import trace_async

MAX_IMAGES = 9
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024
IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
IMAGE_URL_PATHS = {
    "static.dingtalk.com": "/media/",
    "down.dingtalk.com": "/ddmedia/",
}


def parse_image_urls(value: object) -> list[str]:
    """Only accept the HTTPS media URLs emitted by the DingTalk upload component."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_IMAGES:
        raise ValueError("追问图片必须是数组，最多 9 张")
    urls = []
    for url in value:
        if not isinstance(url, str) or len(url) > 4096:
            raise ValueError("无效的追问图片地址")
        parsed = urlsplit(url)
        allowed_path = IMAGE_URL_PATHS.get(parsed.netloc)
        if (
            parsed.scheme != "https"
            or allowed_path is None
            or not parsed.path.startswith(allowed_path)
            or parsed.fragment
        ):
            raise ValueError("追问图片必须来自钉钉图片上传组件")
        if url not in urls:
            urls.append(url)
    return urls


async def _download_image(client: httpx.AsyncClient, url: str, limit: int) -> bytes:
    async with client.stream("GET", url) as response:
        response.raise_for_status()
        mime_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
        if mime_type not in IMAGE_MIME_TYPES:
            raise ValueError("图片格式不支持，请上传 PNG、JPEG、GIF 或 WebP")
        declared = response.headers.get("content-length")
        if declared and int(declared) > limit:
            raise ValueError("图片过大：单张最多 10 MB，总计最多 30 MB")
        content = bytearray()
        async for chunk in response.aiter_bytes():
            if len(content) + len(chunk) > limit:
                raise ValueError("图片过大：单张最多 10 MB，总计最多 30 MB")
            content.extend(chunk)
    if not content:
        raise ValueError("图片内容为空，请重新上传")
    return bytes(content)


def _encode_image(content: bytes) -> dict[str, str]:
    """Verify image bytes before handing them to attachment persistence."""
    from io import BytesIO

    from PIL import Image

    try:
        with Image.open(BytesIO(content)) as image:
            mime_type = Image.MIME.get(image.format)
            if mime_type not in IMAGE_MIME_TYPES:
                raise ValueError("Unsupported image format")
            image.verify()
    except Exception as exc:
        raise ValueError("图片内容无效，请重新上传") from exc
    return {
        "mime_type": mime_type,
        "base64_data": base64.b64encode(content).decode("ascii"),
    }


@trace_async(
    span_name="dingtalk.card.download_images", tracer_name="backend.channels.dingtalk"
)
async def download_card_images(urls: list[str]) -> list[dict[str, str]]:
    if not urls:
        return []
    urls = parse_image_urls(urls)
    images = []
    total = 0
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            for url in urls:
                content = await _download_image(
                    client, url, min(MAX_IMAGE_BYTES, MAX_TOTAL_BYTES - total)
                )
                images.append(_encode_image(content))
                total += len(content)
    except httpx.HTTPError as exc:
        raise ValueError("图片下载失败，请重新上传后重试") from exc
    return images
