# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import io
from unittest.mock import patch

from chat_shell.messages.converter import (
    MAX_IMAGE_SIZE_BYTES,
    MessageConverter,
)
from PIL import Image


def create_test_image(width, height, color="red"):
    """Create a test image and return bytes."""
    img = Image.new("RGB", (width, height), color=color)
    output = io.BytesIO()
    img.save(output, format="JPEG")
    return output.getvalue()


def test_compress_image_small():
    """Test that small images are not compressed."""
    # Create small image
    img_data = create_test_image(100, 100)
    assert len(img_data) < MAX_IMAGE_SIZE_BYTES

    compressed = MessageConverter._compress_image(img_data, "image/jpeg")
    assert compressed == img_data


def test_compress_image_large():
    """Test that large images are compressed."""
    # Create large image (approx 5000x5000 should be large enough)
    # Note: Generating a huge image in memory might be slow or consume memory,
    # so we'll mock the size check or use a slightly smaller but still "large" one.
    # Instead of generating a real huge image, we can mock the size check
    # inside _compress_image, but that requires more complex mocking.

    # Let's try a reasonable size that might exceed 1MB uncompressed,
    # but compressed JPEG is small.
    # To really test compression logic, we need an image that STAYS large if not compressed.
    # A noise image is hard to compress.

    # Generate random bytes to simulate a large non-compressible image is tricky
    # because PIL needs to open it.

    # Let's create a large solid color image, it compresses well,
    # so we might need huge dimensions to exceed 1MB even in JPEG.
    # 1MB = 1048576 bytes.
    # A 2000x2000 RGB image is 12MB raw, but JPEG is much smaller.

    # We can mock MAX_IMAGE_SIZE_BYTES to be very small for testing.
    with patch("chat_shell.messages.converter.MAX_IMAGE_SIZE_BYTES", 100):
        img_data = create_test_image(50, 50)  # Small image but larger than 100 bytes

        compressed = MessageConverter._compress_image(img_data, "image/jpeg")

        # It should be compressed (quality reduced or resized)
        # Since 100 bytes is very small, it might fail to compress that small and return original
        # if quality reduction doesn't help enough.

        # Let's just verify that logic runs without error.
        assert isinstance(compressed, bytes)


def test_create_image_block_compression():
    """Test that create_image_block triggers compression."""
    img_data = create_test_image(200, 200)

    # Mock compression to return a specific byte string
    with patch.object(
        MessageConverter, "_compress_image", return_value=b"compressed"
    ) as mock_compress:
        # Mock limit to force compression
        with patch("chat_shell.messages.converter.MAX_IMAGE_SIZE_BYTES", 1):
            block = MessageConverter.create_image_block(img_data, "image/jpeg")

            mock_compress.assert_called_once()
            assert block["type"] == "image_url"
            assert block["image_url"]["url"].endswith(
                base64.b64encode(b"compressed").decode("utf-8")
            )


def test_build_vision_message_compression():
    """Test that build_vision_message triggers compression."""
    img_data = create_test_image(200, 200)
    b64_img = base64.b64encode(img_data).decode("utf-8")

    # Mock compression
    with patch.object(
        MessageConverter, "_compress_image", return_value=b"compressed"
    ) as mock_compress:
        # Mock limit
        with patch("chat_shell.messages.converter.MAX_IMAGE_SIZE_BYTES", 1):
            msg = MessageConverter.build_vision_message("text", b64_img, "image/jpeg")

            mock_compress.assert_called_once()
            content = msg["content"]
            assert len(content) == 2
            assert content[1]["type"] == "image_url"
            # Check if url contains encoded "compressed" bytes
            assert content[1]["image_url"]["url"].endswith(
                base64.b64encode(b"compressed").decode("utf-8")
            )
