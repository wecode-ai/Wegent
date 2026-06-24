# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io

from PIL import Image

from executor.services.image_preprocessor import prepare_image_bytes_for_model


def _image_bytes(format_name: str, size: tuple[int, int] = (16, 8)) -> bytes:
    image = Image.new("RGB", size, color=(32, 144, 208))
    output = io.BytesIO()
    image.save(output, format=format_name)
    return output.getvalue()


def _animated_gif_bytes(size: tuple[int, int] = (256, 128)) -> bytes:
    frames = [
        Image.new("RGB", size, color=(32, 144, 208)),
        Image.new("RGB", size, color=(208, 96, 32)),
    ]
    output = io.BytesIO()
    frames[0].save(
        output,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=80,
        loop=0,
    )
    return output.getvalue()


def test_bmp_within_limit_is_converted_to_png():
    prepared = prepare_image_bytes_for_model(
        _image_bytes("BMP"),
        "image/bmp",
    )

    assert prepared.mime_type == "image/png"
    assert prepared.data.startswith(b"\x89PNG\r\n\x1a\n")
    assert prepared.original_size == (16, 8)
    assert prepared.size == (16, 8)
    assert prepared.resized is True


def test_animated_gif_resize_outputs_first_frame_as_png():
    prepared = prepare_image_bytes_for_model(
        _animated_gif_bytes(),
        "image/gif",
        max_long_edge=128,
    )

    assert prepared.mime_type == "image/png"
    assert prepared.data.startswith(b"\x89PNG\r\n\x1a\n")
    with Image.open(io.BytesIO(prepared.data)) as image:
        assert image.format == "PNG"
        assert image.size == (128, 64)
    assert prepared.resized is True
