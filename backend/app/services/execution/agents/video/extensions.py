# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Extension points for optional video-generation integrations."""

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol


@dataclass(frozen=True)
class VideoStatusOverride:
    """Optional status values extracted from a provider response."""

    progress: int
    is_completed: bool
    is_failed: bool
    error: Optional[str] = None


@dataclass(frozen=True)
class VideoResultOverride:
    """Optional result values extracted from a provider response."""

    video_url: Optional[str] = None
    thumbnail: Optional[str] = None
    duration: Optional[float] = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PreparedVideoArtifact:
    """Persisted video result and its client-facing representation."""

    video_url: str
    websocket_video_url: str
    attachment_id: Optional[int]
    thumbnail: Optional[str]
    duration: Optional[float]
    block_metadata: dict[str, Any] = field(default_factory=dict)


class VideoGenerationExtension(Protocol):
    """Optional integration for provider inputs, responses, and result storage."""

    def resolve_material(
        self,
        *,
        type_data: dict[str, Any],
        media_type: str,
    ) -> Optional[dict[str, Any]]:
        """Resolve an attachment into a provider-independent descriptor."""

    def build_provider_content(
        self,
        *,
        protocol: str,
        media_type: str,
        descriptor: dict[str, Any],
        role: str,
    ) -> Optional[dict[str, Any]]:
        """Build a provider content block for an external descriptor."""

    def parse_status(
        self,
        response: dict[str, Any],
        fallback: VideoStatusOverride,
    ) -> Optional[VideoStatusOverride]:
        """Override provider status parsing."""

    def parse_result(
        self,
        response: dict[str, Any],
        fallback: VideoResultOverride,
    ) -> Optional[VideoResultOverride]:
        """Override provider result parsing."""

    def prepare_result(
        self,
        *,
        result: Any,
        user_id: int,
        task_id: int,
        subtask_id: int,
    ) -> Optional[PreparedVideoArtifact]:
        """Persist a generated result when handled by this extension."""

    def refresh_result_urls(
        self,
        *,
        task: dict[str, Any],
        user_id: int,
    ) -> None:
        """Refresh temporary URLs in a task response in place."""


_extensions: list[VideoGenerationExtension] = []


def register_video_generation_extension(extension: VideoGenerationExtension) -> None:
    """Register a video-generation extension."""
    _extensions.append(extension)


def resolve_external_material(
    type_data: dict[str, Any],
    media_type: str,
) -> Optional[dict[str, Any]]:
    """Resolve an attachment using registered extensions."""
    for extension in _extensions:
        descriptor = extension.resolve_material(
            type_data=type_data,
            media_type=media_type,
        )
        if descriptor is not None:
            return descriptor
    return None


def build_external_provider_content(
    *,
    protocol: str,
    media_type: str,
    descriptor: dict[str, Any],
    role: str,
) -> Optional[dict[str, Any]]:
    """Build provider content using registered extensions."""
    for extension in _extensions:
        content = extension.build_provider_content(
            protocol=protocol,
            media_type=media_type,
            descriptor=descriptor,
            role=role,
        )
        if content is not None:
            return content
    return None


def parse_extended_status(
    response: dict[str, Any],
    fallback: VideoStatusOverride,
) -> VideoStatusOverride:
    """Apply the first registered status parser that handles the response."""
    for extension in _extensions:
        parsed = extension.parse_status(response, fallback)
        if parsed is not None:
            return parsed
    return fallback


def parse_extended_result(
    response: dict[str, Any],
    fallback: VideoResultOverride,
) -> VideoResultOverride:
    """Apply the first registered result parser that handles the response."""
    for extension in _extensions:
        parsed = extension.parse_result(response, fallback)
        if parsed is not None:
            return parsed
    return fallback


def prepare_extended_video_result(
    *,
    result: Any,
    user_id: int,
    task_id: int,
    subtask_id: int,
) -> Optional[PreparedVideoArtifact]:
    """Persist a generated result using the first matching extension."""
    for extension in _extensions:
        artifact = extension.prepare_result(
            result=result,
            user_id=user_id,
            task_id=task_id,
            subtask_id=subtask_id,
        )
        if artifact is not None:
            return artifact
    return None


def refresh_extended_video_result_urls(
    task: dict[str, Any],
    user_id: int,
) -> None:
    """Refresh client-facing video URLs using all registered extensions."""
    for extension in _extensions:
        extension.refresh_result_urls(task=task, user_id=user_id)
