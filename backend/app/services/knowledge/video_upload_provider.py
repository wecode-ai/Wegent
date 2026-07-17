# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""KB video upload provider framework (two-phase object-storage contract).

KB video uploads do NOT use the generic ``/attachments/upload`` path (which
stores bytes via ``StorageBackend.save`` under a 100 MB cap). Videos are too
large for in-memory storage and belong on object storage (GCS / OSS / ...).
The contract is two-phase:

  1. ``init_upload`` — the backend returns the target the *frontend* uploads
     the binary to (presigned URL / GCS resumable session / ...). The binary
     never enters backend memory.
  2. ``complete_upload`` — after the frontend upload, the backend stores only
     metadata (object key + ``storage_backend`` marker) in ``type_data``. No
     binary is persisted on the backend.

The open-source build ships ``NoOpVideoUploadProvider``: KB video upload is
rejected with a clear ``video_upload_not_configured`` error, mirroring
``NoOpStagingProvider``. Internal deployments register a concrete provider
via ``register_video_upload_provider()`` — the framework is the seam.

Mirrors the existing multimodal isolation pattern (MediaStagingProvider,
video-download-registry): Protocol + NoOp default + provider fills in.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol

from app.models.user import User


class VideoUploadNotConfiguredError(Exception):
    """No video upload provider is registered (open-source default)."""


@dataclass
class VideoUploadTarget:
    """Where the frontend uploads the video binary (phase 1).

    The frontend POSTs/PUTs the file to ``upload_url`` with ``headers`` and any
    provider-specific ``extra`` fields, then calls ``complete`` with the
    resulting object key.
    """

    upload_url: str
    method: str = "POST"
    headers: Dict[str, str] = field(default_factory=dict)
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class VideoUploadCompleteResult:
    """Metadata stored after the frontend upload (phase 2).

    Carries the attachment id and the ``type_data`` marker fields the
    multimodal dispatch reads later (``storage_backend`` + object key).
    """

    attachment_id: int
    storage_backend: str  # "gcs" | "oss" | ...
    object_key: str  # object key — provider-specific


class VideoUploadProvider(Protocol):
    """Two-phase object-storage upload contract for KB video."""

    def init_upload(
        self,
        *,
        filename: str,
        file_size: int,
        file_extension: str,
        uploader: User,
    ) -> VideoUploadTarget:
        """Return the target the frontend uploads the binary to."""
        ...

    def complete_upload(
        self,
        *,
        upload_result: Dict[str, Any],
        filename: str,
        file_size: int,
        file_extension: str,
        uploader: User,
    ) -> VideoUploadCompleteResult:
        """Register metadata after the frontend upload.

        ``upload_result`` carries the object key returned by the object-storage
        upload (provider-specific shape). Stores ``type_data`` only — no binary.
        """
        ...


class NoOpVideoUploadProvider:
    """Default provider — KB video upload is not configured (open-source)."""

    def init_upload(self, **_: Any) -> VideoUploadTarget:
        raise VideoUploadNotConfiguredError(
            "KB video upload is not configured (no VideoUploadProvider registered)"
        )

    def complete_upload(self, **_: Any) -> VideoUploadCompleteResult:
        raise VideoUploadNotConfiguredError(
            "KB video upload is not configured (no VideoUploadProvider registered)"
        )


_provider: Optional[VideoUploadProvider] = None


def register_video_upload_provider(provider: VideoUploadProvider) -> None:
    """Register a concrete provider (internal deployments)."""
    global _provider
    _provider = provider


def build_video_upload_provider() -> VideoUploadProvider:
    """Return the registered provider, or the NoOp default (open-source)."""
    return _provider if _provider is not None else NoOpVideoUploadProvider()
