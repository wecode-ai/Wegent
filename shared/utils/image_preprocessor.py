# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Image preprocessing utilities for model inputs."""

from __future__ import annotations

import io
import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)

MAX_MODEL_IMAGE_LONG_EDGE = 1568
MODEL_IMAGE_JPEG_QUALITY = 85
MIN_MODEL_IMAGE_QUALITY = 15
MIN_MODEL_IMAGE_LONG_EDGE = 100

_MIME_OUTPUTS = {
    "image/png": ("PNG", "image/png", ".png"),
    "image/jpeg": ("JPEG", "image/jpeg", ".jpg"),
    "image/jpg": ("JPEG", "image/jpeg", ".jpg"),
    "image/gif": ("GIF", "image/gif", ".gif"),
    "image/webp": ("WEBP", "image/webp", ".webp"),
    "image/bmp": ("PNG", "image/png", ".png"),
}


@dataclass(frozen=True)
class PreparedModelImage:
    """Image bytes prepared for model submission."""

    data: bytes
    mime_type: str
    original_size: tuple[int, int] | None
    size: tuple[int, int] | None
    resized: bool


def prepare_image_bytes_for_model(
    image_data: bytes,
    mime_type: str | None,
    max_long_edge: int = MAX_MODEL_IMAGE_LONG_EDGE,
    max_size_bytes: int | None = None,
) -> PreparedModelImage:
    """Normalize image bytes for model input constraints.

    The returned ``resized`` flag means the output bytes differ from the input
    bytes. The change may be a resize, a format conversion, or size compression.
    """

    if not image_data:
        return _unchanged(image_data, mime_type)

    try:
        from PIL import Image
    except ImportError:
        logger.warning("Pillow is unavailable; model image preprocessing skipped")
        return _unchanged(image_data, mime_type)

    try:
        with Image.open(io.BytesIO(image_data)) as image:
            original_size = image.size
            input_mime = _coerce_mime_type(mime_type)
            output_format, output_mime, _ = _resolve_output(input_mime)

            needs_resize = max(original_size) > max_long_edge
            needs_convert = output_mime != input_mime
            needs_size_compression = (
                max_size_bytes is not None and len(image_data) > max_size_bytes
            )
            if not needs_resize and not needs_convert and not needs_size_compression:
                return PreparedModelImage(
                    data=image_data,
                    mime_type=input_mime,
                    original_size=original_size,
                    size=original_size,
                    resized=False,
                )

            if output_format == "GIF" and getattr(image, "n_frames", 1) > 1:
                logger.info(
                    "Animated GIF with %d frames: saving first frame as PNG for model input",
                    image.n_frames,
                )
                output_format, output_mime = "PNG", "image/png"

            prepared = image.copy()
            if needs_resize:
                prepared.thumbnail(
                    (max_long_edge, max_long_edge),
                    Image.Resampling.LANCZOS,
                    reducing_gap=3.0,
                )

            prepared = _normalize_mode_for_output(prepared, output_format)
            output_data, output_size = _encode_with_constraints(
                prepared,
                output_format,
                max_size_bytes=max_size_bytes,
            )
            return PreparedModelImage(
                data=output_data,
                mime_type=output_mime,
                original_size=original_size,
                size=output_size,
                resized=True,
            )
    except Exception as exc:
        logger.warning("Failed to preprocess model image: %s", exc)
        return _unchanged(image_data, mime_type)


def prepare_image_file_for_model(
    local_path: str,
    mime_type: str | None,
    max_long_edge: int = MAX_MODEL_IMAGE_LONG_EDGE,
    max_size_bytes: int | None = None,
) -> str:
    """Return a local image path that is safe to pass to a model client."""

    try:
        with open(local_path, "rb") as image_file:
            image_data = image_file.read()
    except OSError as exc:
        logger.warning("Failed to read model image %s: %s", local_path, exc)
        return local_path

    prepared = prepare_image_bytes_for_model(
        image_data,
        mime_type,
        max_long_edge=max_long_edge,
        max_size_bytes=max_size_bytes,
    )
    if not prepared.resized:
        return local_path

    output_path = _model_input_path(local_path, prepared.mime_type)
    try:
        with open(output_path, "wb") as image_file:
            image_file.write(prepared.data)
    except OSError as exc:
        logger.warning("Failed to write model image %s: %s", output_path, exc)
        return local_path

    logger.info(
        "Prepared model image %s from %s to %s at %s",
        local_path,
        prepared.original_size,
        prepared.size,
        output_path,
    )
    return output_path


def _unchanged(image_data: bytes, mime_type: str | None) -> PreparedModelImage:
    return PreparedModelImage(
        data=image_data,
        mime_type=_coerce_mime_type(mime_type),
        original_size=None,
        size=None,
        resized=False,
    )


def _coerce_mime_type(mime_type: str | None) -> str:
    return (mime_type or "image/png").lower()


def _resolve_output(mime_type: str | None) -> tuple[str, str, str]:
    return _MIME_OUTPUTS.get(
        _coerce_mime_type(mime_type),
        ("PNG", "image/png", ".png"),
    )


def _encode_with_constraints(
    image,
    output_format: str,
    max_size_bytes: int | None = None,
) -> tuple[bytes, tuple[int, int]]:
    quality = MODEL_IMAGE_JPEG_QUALITY
    encoded = _encode_image(image, output_format, quality)
    if max_size_bytes is None or len(encoded) <= max_size_bytes:
        return encoded, image.size

    if output_format in ("JPEG", "WEBP"):
        while quality > MIN_MODEL_IMAGE_QUALITY:
            quality -= 10
            encoded = _encode_image(image, output_format, quality)
            if len(encoded) <= max_size_bytes:
                return encoded, image.size

    current = image
    while (
        len(encoded) > max_size_bytes and max(current.size) > MIN_MODEL_IMAGE_LONG_EDGE
    ):
        from PIL import Image

        width, height = current.size
        next_size = (max(1, int(width * 0.8)), max(1, int(height * 0.8)))
        current = current.resize(next_size, Image.Resampling.LANCZOS)
        encoded = _encode_image(current, output_format, quality)

    return encoded, current.size


def _encode_image(image, output_format: str, quality: int) -> bytes:
    output = io.BytesIO()
    image.save(output, **_save_options(output_format, quality))
    return output.getvalue()


def _save_options(output_format: str, quality: int) -> dict[str, object]:
    if output_format == "JPEG":
        return {
            "format": output_format,
            "quality": quality,
            "optimize": True,
        }
    if output_format == "WEBP":
        return {
            "format": output_format,
            "quality": quality,
            "method": 6,
        }
    return {"format": output_format, "optimize": True}


def _normalize_mode_for_output(image, output_format: str):
    if output_format == "JPEG":
        if image.mode == "RGB":
            return image
        if image.mode in ("RGBA", "LA"):
            from PIL import Image

            background = Image.new("RGB", image.size, (255, 255, 255))
            alpha = image.getchannel("A")
            background.paste(image.convert("RGB"), mask=alpha)
            return background
        return image.convert("RGB")

    if output_format == "PNG" and image.mode == "CMYK":
        return image.convert("RGB")

    if output_format == "WEBP" and image.mode not in ("RGB", "RGBA"):
        return image.convert("RGB")

    return image


def _model_input_path(local_path: str, mime_type: str) -> str:
    output_format, _, extension = _resolve_output(mime_type)
    if output_format == "JPEG":
        extension = ".jpg"

    base, _ = os.path.splitext(local_path)
    return f"{base}.model-input{extension}"
