# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Image preprocessing for model inputs."""

from __future__ import annotations

import io
import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)

MAX_MODEL_IMAGE_LONG_EDGE = 2048
MODEL_IMAGE_JPEG_QUALITY = 85

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
) -> PreparedModelImage:
    """Downscale image bytes when they exceed the model input size limit."""

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
            if max(original_size) <= max_long_edge:
                return PreparedModelImage(
                    data=image_data,
                    mime_type=_coerce_mime_type(mime_type),
                    original_size=original_size,
                    size=original_size,
                    resized=False,
                )

            prepared = image.copy()
            prepared.thumbnail(
                (max_long_edge, max_long_edge),
                Image.Resampling.LANCZOS,
                reducing_gap=3.0,
            )
            output_format, output_mime, _ = _resolve_output(mime_type)
            output = io.BytesIO()
            prepared = _normalize_mode_for_output(prepared, output_format)
            prepared.save(output, **_save_options(output_format))
            return PreparedModelImage(
                data=output.getvalue(),
                mime_type=output_mime,
                original_size=original_size,
                size=prepared.size,
                resized=True,
            )
    except Exception as exc:
        logger.warning("Failed to preprocess model image: %s", exc)
        return _unchanged(image_data, mime_type)


def prepare_image_file_for_model(
    local_path: str,
    mime_type: str | None,
    max_long_edge: int = MAX_MODEL_IMAGE_LONG_EDGE,
) -> str:
    """Return a local image path that is safe to pass to a model client."""

    try:
        with open(local_path, "rb") as image_file:
            image_data = image_file.read()
    except OSError as exc:
        logger.warning("Failed to read model image %s: %s", local_path, exc)
        return local_path

    prepared = prepare_image_bytes_for_model(image_data, mime_type, max_long_edge)
    if not prepared.resized:
        return local_path

    output_path = _model_input_path(local_path, prepared.mime_type)
    try:
        with open(output_path, "wb") as image_file:
            image_file.write(prepared.data)
    except OSError as exc:
        logger.warning("Failed to write resized model image %s: %s", output_path, exc)
        return local_path

    logger.info(
        "Resized model image %s from %s to %s at %s",
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
    return mime_type or "image/png"


def _resolve_output(mime_type: str | None) -> tuple[str, str, str]:
    return _MIME_OUTPUTS.get(
        _coerce_mime_type(mime_type).lower(), ("PNG", "image/png", ".png")
    )


def _save_options(output_format: str) -> dict[str, object]:
    if output_format == "JPEG":
        return {
            "format": output_format,
            "quality": MODEL_IMAGE_JPEG_QUALITY,
            "optimize": True,
        }
    if output_format == "WEBP":
        return {
            "format": output_format,
            "quality": MODEL_IMAGE_JPEG_QUALITY,
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
