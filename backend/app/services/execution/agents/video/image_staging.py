# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pluggable staging for images sent to video generation providers."""

from abc import ABC, abstractmethod
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

from app.core.config import settings
from app.services.attachment.public_link import generate_public_attachment_token


class VideoImageStagingBackend(ABC):
    """Prepare reference images for a remote video generation provider."""

    @abstractmethod
    async def stage(
        self,
        images: list[dict[str, Any]],
        user_id: int,
    ) -> list[dict[str, Any]]:
        """Return provider-readable image descriptors."""


class DirectVideoImageStagingBackend(VideoImageStagingBackend):
    """Keep the existing image URLs unchanged."""

    async def stage(
        self,
        images: list[dict[str, Any]],
        user_id: int,
    ) -> list[dict[str, Any]]:
        del user_id
        staged: list[dict[str, Any]] = []
        for image in images:
            descriptor = dict(image)
            if not descriptor.get("url"):
                attachment_id = descriptor.get("attachment_id")
                if not isinstance(attachment_id, int):
                    raise ValueError("Video reference image has no readable URL")
                descriptor["url"] = _public_attachment_url(attachment_id)
            staged.append(descriptor)
        return staged


_backend: VideoImageStagingBackend = DirectVideoImageStagingBackend()


def register_video_image_staging_backend(
    backend: VideoImageStagingBackend,
) -> None:
    """Replace the process-wide video image staging backend."""
    global _backend
    _backend = backend


async def stage_video_reference_images(
    images: list[dict[str, Any]],
    user_id: int,
) -> list[dict[str, Any]]:
    """Stage images only when a video request is about to be submitted."""
    if not images:
        return []
    return await _backend.stage(images, user_id)


def _public_attachment_url(attachment_id: int) -> str:
    public_base_url = settings.ATTACHMENT_PUBLIC_BASE_URL.strip().rstrip("/")
    if not public_base_url:
        raise ValueError(
            "ATTACHMENT_PUBLIC_BASE_URL must be configured when video image "
            "staging uses the direct backend"
        )
    token = generate_public_attachment_token(
        attachment_id,
        timedelta(hours=1),
    )
    query = urlencode({"token": token})
    return f"{public_base_url}/api/attachments/download/shared?{query}"
