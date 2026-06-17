# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import io
from unittest.mock import patch

import pytest
from PIL import Image

from chat_shell.messages.converter import (
    MAX_IMAGE_LONG_EDGE,
    MAX_IMAGE_SIZE_BYTES,
    MessageConverter,
)


def create_test_image(
    width: int, height: int, color: str = "red", fmt: str = "JPEG"
) -> bytes:
    """Create a test image and return its bytes."""
    img = Image.new("RGB", (width, height), color=color)
    output = io.BytesIO()
    img.save(output, format=fmt)
    return output.getvalue()


def get_image_dimensions(img_bytes: bytes) -> tuple[int, int]:
    """Return (width, height) of image bytes."""
    img = Image.open(io.BytesIO(img_bytes))
    return img.size


# ---------------------------------------------------------------------------
# _compress_image: size-only path (unchanged behaviour for small dimensions)
# ---------------------------------------------------------------------------


def test_compress_image_small_within_limits():
    """Small image within both dimension and size limits is returned unchanged."""
    img_data = create_test_image(100, 100)
    assert len(img_data) < MAX_IMAGE_SIZE_BYTES

    result = MessageConverter._compress_image(img_data, "image/jpeg")

    # Same object returned (identity) when nothing changed.
    assert result is img_data


def test_compress_image_oversized_file_reduced():
    """Image whose encoded size exceeds MAX_IMAGE_SIZE_BYTES is compressed."""
    with patch("chat_shell.messages.converter.MAX_IMAGE_SIZE_BYTES", 100):
        img_data = create_test_image(50, 50)

        result = MessageConverter._compress_image(img_data, "image/jpeg")

        assert isinstance(result, bytes)
        # Result must differ from input because compression was applied.
        assert result is not img_data


# ---------------------------------------------------------------------------
# _compress_image: dimension enforcement (new behaviour)
# ---------------------------------------------------------------------------


def test_compress_image_oversized_dimension_is_resized():
    """Image with long edge > MAX_IMAGE_LONG_EDGE is downscaled to the limit."""
    # Tall image: 100 wide, 13768 tall (the real-world failing case).
    img_data = create_test_image(100, 13768)

    result = MessageConverter._compress_image(img_data, "image/jpeg")

    out_w, out_h = get_image_dimensions(result)
    assert max(out_w, out_h) <= MAX_IMAGE_LONG_EDGE


def test_compress_image_wide_dimension_is_resized():
    """Wide image with long edge > MAX_IMAGE_LONG_EDGE is downscaled."""
    img_data = create_test_image(9000, 100)

    result = MessageConverter._compress_image(img_data, "image/jpeg")

    out_w, out_h = get_image_dimensions(result)
    assert max(out_w, out_h) <= MAX_IMAGE_LONG_EDGE


def test_compress_image_aspect_ratio_preserved():
    """Resized image preserves the original aspect ratio (within 1px rounding)."""
    orig_w, orig_h = 100, 10000  # 1:100 ratio
    img_data = create_test_image(orig_w, orig_h)

    result = MessageConverter._compress_image(img_data, "image/jpeg")

    out_w, out_h = get_image_dimensions(result)
    # Expected width: 100 * (1568 / 10000) ≈ 15
    expected_w = max(1, int(orig_w * MAX_IMAGE_LONG_EDGE / max(orig_w, orig_h)))
    assert abs(out_w - expected_w) <= 1


def test_compress_image_small_dimension_unchanged():
    """Image whose long edge is exactly at the limit is returned unchanged (no re-encode)."""
    img_data = create_test_image(MAX_IMAGE_LONG_EDGE, 100)
    assert len(img_data) < MAX_IMAGE_SIZE_BYTES

    result = MessageConverter._compress_image(img_data, "image/jpeg")

    assert result is img_data  # Identity: no processing performed.


def test_compress_image_small_file_but_large_dimension():
    """Image that is small in bytes but has a dimension > 1568px must still be resized."""
    # A tiny solid-colour image can be large in pixels but small as JPEG.
    img_data = create_test_image(100, 9000)
    assert (
        len(img_data) < MAX_IMAGE_SIZE_BYTES
    )  # Confirm it wouldn't trigger the old size guard.

    result = MessageConverter._compress_image(img_data, "image/jpeg")

    out_w, out_h = get_image_dimensions(result)
    assert max(out_w, out_h) <= MAX_IMAGE_LONG_EDGE


def test_compress_image_png_oversized_dimension():
    """PNG image with oversized dimension is also resized (format preserved if small enough)."""
    img_data = create_test_image(100, 9000, fmt="PNG")

    result = MessageConverter._compress_image(img_data, "image/png")

    out_w, out_h = get_image_dimensions(result)
    assert max(out_w, out_h) <= MAX_IMAGE_LONG_EDGE


# ---------------------------------------------------------------------------
# _convert_responses_api_to_langchain: integration path
# ---------------------------------------------------------------------------


def test_build_messages_normalizes_oversized_dimension():
    """build_messages normalises an oversized image in an input_image block."""
    # Create a tall image that exceeds the dimension limit.
    img_data = create_test_image(100, 9000)
    b64_img = base64.b64encode(img_data).decode("utf-8")

    content_blocks = [
        {"type": "input_text", "text": "describe this image"},
        {"type": "input_image", "image_url": f"data:image/jpeg;base64,{b64_img}"},
    ]

    messages = MessageConverter.build_messages(
        history=[],
        current_message=content_blocks,
        system_prompt="",
        inject_datetime=False,
    )

    user_msg = messages[-1]
    image_block = next(b for b in user_msg["content"] if b.get("type") == "image_url")
    url = image_block["image_url"]["url"]
    _, encoded = url.split(",", 1)
    result_bytes = base64.b64decode(encoded)
    out_w, out_h = get_image_dimensions(result_bytes)
    assert max(out_w, out_h) <= MAX_IMAGE_LONG_EDGE


def test_build_messages_leaves_small_image_unchanged():
    """build_messages does not modify an image that is already within all limits."""
    img_data = create_test_image(400, 300)
    b64_img = base64.b64encode(img_data).decode("utf-8")

    content_blocks = [
        {"type": "input_text", "text": "describe this image"},
        {"type": "input_image", "image_url": f"data:image/jpeg;base64,{b64_img}"},
    ]

    messages = MessageConverter.build_messages(
        history=[],
        current_message=content_blocks,
        system_prompt="",
        inject_datetime=False,
    )

    user_msg = messages[-1]
    image_block = next(b for b in user_msg["content"] if b.get("type") == "image_url")
    url = image_block["image_url"]["url"]
    _, encoded = url.split(",", 1)
    # Decoded bytes should be byte-equal to the original (no unnecessary re-encode).
    assert base64.b64decode(encoded) == img_data


# ---------------------------------------------------------------------------
# create_image_block: always-normalize path
# ---------------------------------------------------------------------------


def test_create_image_block_normalizes_oversized_dimension():
    """create_image_block resizes an image with dimension > MAX_IMAGE_LONG_EDGE."""
    img_data = create_test_image(100, 9000)

    block = MessageConverter.create_image_block(img_data, "image/jpeg")

    url = block["image_url"]["url"]
    _, encoded = url.split(",", 1)
    out_w, out_h = get_image_dimensions(base64.b64decode(encoded))
    assert max(out_w, out_h) <= MAX_IMAGE_LONG_EDGE


def test_create_image_block_compression():
    """create_image_block calls _compress_image even when image is below size limit."""
    img_data = create_test_image(200, 200)

    with patch.object(
        MessageConverter, "_compress_image", return_value=b"compressed"
    ) as mock_compress:
        block = MessageConverter.create_image_block(img_data, "image/jpeg")

        # Must always be called regardless of file size.
        mock_compress.assert_called_once_with(img_data, "image/jpeg")
        assert block["type"] == "image_url"
        assert block["image_url"]["url"].endswith(
            base64.b64encode(b"compressed").decode("utf-8")
        )
