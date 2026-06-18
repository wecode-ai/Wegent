# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import io
from unittest.mock import patch

from PIL import Image

from chat_shell.messages.converter import (
    MAX_IMAGE_LONG_EDGE,
    MAX_IMAGE_SIZE_BYTES,
    MessageConverter,
)
from shared.utils.image_preprocessor import PreparedModelImage


def create_test_image(width, height, color="red", fmt="JPEG"):
    """Create a test image and return bytes."""
    img = Image.new("RGB", (width, height), color=color)
    output = io.BytesIO()
    img.save(output, format=fmt)
    return output.getvalue()


def get_image_dimensions(img_bytes: bytes) -> tuple[int, int]:
    """Return image dimensions from encoded image bytes."""
    with Image.open(io.BytesIO(img_bytes)) as image:
        return image.size


def test_compress_image_small():
    """Test that small images are not compressed."""
    # Create small image
    img_data = create_test_image(100, 100)
    assert len(img_data) < MAX_IMAGE_SIZE_BYTES

    compressed = MessageConverter._compress_image(img_data, "image/jpeg")
    assert compressed is img_data


def test_compress_image_large():
    """Test that large images are compressed."""
    with patch("chat_shell.messages.converter.MAX_IMAGE_SIZE_BYTES", 100):
        img_data = create_test_image(50, 50)

        compressed = MessageConverter._compress_image(img_data, "image/jpeg")

        assert isinstance(compressed, bytes)
        assert compressed is not img_data


def test_compress_image_small_file_but_large_dimension():
    """Image below byte limit but above dimension limit is resized."""
    img_data = create_test_image(100, 9000)
    assert len(img_data) < MAX_IMAGE_SIZE_BYTES

    compressed = MessageConverter._compress_image(img_data, "image/jpeg")

    width, height = get_image_dimensions(compressed)
    assert max(width, height) <= MAX_IMAGE_LONG_EDGE


def test_compress_image_preserves_aspect_ratio():
    """Resized image preserves aspect ratio within rounding tolerance."""
    orig_width, orig_height = 100, 9000
    img_data = create_test_image(orig_width, orig_height)

    compressed = MessageConverter._compress_image(img_data, "image/jpeg")

    width, height = get_image_dimensions(compressed)
    expected_width = max(
        1,
        int(orig_width * MAX_IMAGE_LONG_EDGE / max(orig_width, orig_height)),
    )
    assert height == MAX_IMAGE_LONG_EDGE
    assert abs(width - expected_width) <= 1


def test_create_image_block_compression():
    """Test that create_image_block uses prepared bytes and MIME type."""
    img_data = create_test_image(200, 200)
    prepared = PreparedModelImage(
        data=b"prepared",
        mime_type="image/png",
        original_size=(200, 200),
        size=(200, 200),
        resized=True,
    )

    with patch.object(
        MessageConverter, "_prepare_image_for_model", return_value=prepared
    ) as mock_prepare:
        block = MessageConverter.create_image_block(img_data, "image/jpeg")

        mock_prepare.assert_called_once_with(img_data, "image/jpeg")
        assert block["type"] == "image_url"
        assert block["image_url"]["url"].startswith("data:image/png;base64,")
        assert block["image_url"]["url"].endswith(
            base64.b64encode(b"prepared").decode("utf-8")
        )


def test_build_messages_with_vision_compression():
    """Test that build_messages with vision content uses prepared image data."""
    img_data = create_test_image(200, 200)
    b64_img = base64.b64encode(img_data).decode("utf-8")
    prepared = PreparedModelImage(
        data=b"prepared",
        mime_type="image/jpeg",
        original_size=(200, 200),
        size=(200, 200),
        resized=True,
    )

    content_blocks = [
        {"type": "input_text", "text": "describe this image"},
        {"type": "input_image", "image_url": f"data:image/jpeg;base64,{b64_img}"},
    ]

    with patch.object(
        MessageConverter, "_prepare_image_for_model", return_value=prepared
    ) as mock_prepare:
        messages = MessageConverter.build_messages(
            history=[],
            current_message=content_blocks,
            system_prompt="",
            inject_datetime=False,
        )

        mock_prepare.assert_called_once_with(img_data, "image/jpeg")
        user_msg = messages[-1]
        content = user_msg["content"]
        assert len(content) == 2
        assert content[1]["type"] == "image_url"
        assert content[1]["image_url"]["url"].endswith(
            base64.b64encode(b"prepared").decode("utf-8")
        )


def test_build_messages_normalizes_large_dimension():
    """build_messages normalizes an oversized image in an input_image block."""
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

    image_block = next(
        block for block in messages[-1]["content"] if block.get("type") == "image_url"
    )
    _, encoded = image_block["image_url"]["url"].split(",", 1)
    width, height = get_image_dimensions(base64.b64decode(encoded))
    assert max(width, height) <= MAX_IMAGE_LONG_EDGE


def test_build_messages_updates_mime_type_when_image_is_converted():
    """build_messages updates the data URL MIME type when preprocessing converts it."""
    img_data = create_test_image(32, 32, fmt="BMP")
    b64_img = base64.b64encode(img_data).decode("utf-8")
    content_blocks = [
        {"type": "input_text", "text": "describe this image"},
        {"type": "input_image", "image_url": f"data:image/bmp;base64,{b64_img}"},
    ]

    messages = MessageConverter.build_messages(
        history=[],
        current_message=content_blocks,
        system_prompt="",
        inject_datetime=False,
    )

    image_block = next(
        block for block in messages[-1]["content"] if block.get("type") == "image_url"
    )
    url = image_block["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    _, encoded = url.split(",", 1)
    assert base64.b64decode(encoded).startswith(b"\x89PNG\r\n\x1a\n")
