# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Extension points for attachment storage selected by file type."""

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from sqlalchemy.orm import Session


@dataclass(frozen=True)
class ExternalAttachmentStorageResult:
    """Metadata returned after an external attachment upload."""

    backend_type: str
    storage_key: str = ""
    type_data: dict[str, Any] = field(default_factory=dict)
    skip_parsing: bool = True


@dataclass(frozen=True)
class ExternalAttachmentPlayback:
    """Fresh playback information for an externally stored attachment."""

    url: str
    media_type: str
    cover_url: str | None = None
    delivery_mode: Literal["proxy", "direct"] = "proxy"


@dataclass(frozen=True)
class ExternalAttachmentReference:
    """Stable model-facing reference for an externally stored attachment."""

    name: str
    value: Any


class ExternalAttachmentStorageAdapter(Protocol):
    """Store selected attachment types outside the default attachment backend."""

    @property
    def backend_type(self) -> str:
        """Return the persisted backend identifier."""

    def supports(self, mime_type: str, purpose: str) -> bool:
        """Return whether this adapter should store the attachment."""

    def store(
        self,
        *,
        db: Session,
        user_id: int,
        filename: str,
        mime_type: str,
        data: bytes,
    ) -> ExternalAttachmentStorageResult:
        """Store attachment data and return persistence metadata."""


class ExternalAttachmentPlaybackResolver(Protocol):
    """Resolve externally stored media into a fresh playback URL."""

    def resolve_playback(
        self,
        *,
        type_data: dict[str, Any],
        user_id: int,
    ) -> ExternalAttachmentPlayback | None:
        """Return playback information when this resolver handles the attachment."""


class ExternalAttachmentReferenceResolver(Protocol):
    """Resolve a model-facing reference for an externally stored attachment."""

    def resolve_reference(
        self,
        *,
        type_data: dict[str, Any],
    ) -> ExternalAttachmentReference | None:
        """Return a stable reference when this resolver handles the attachment."""


_adapters: list[ExternalAttachmentStorageAdapter] = []
_playback_resolvers: list[ExternalAttachmentPlaybackResolver] = []
_reference_resolvers: list[ExternalAttachmentReferenceResolver] = []


def register_external_attachment_storage_adapter(
    adapter: ExternalAttachmentStorageAdapter,
) -> None:
    """Register an attachment storage adapter."""
    _adapters.append(adapter)


def find_external_attachment_storage_adapter(
    mime_type: str,
    purpose: str = "default",
) -> ExternalAttachmentStorageAdapter | None:
    """Return the first adapter enabled for the MIME type and upload purpose."""
    return next(
        (adapter for adapter in _adapters if adapter.supports(mime_type, purpose)),
        None,
    )


def register_external_attachment_playback_resolver(
    resolver: ExternalAttachmentPlaybackResolver,
) -> None:
    """Register an external attachment playback resolver."""
    _playback_resolvers.append(resolver)


def resolve_external_attachment_playback(
    *,
    type_data: dict[str, Any],
    user_id: int,
) -> ExternalAttachmentPlayback | None:
    """Resolve playback information using the first matching resolver."""
    for resolver in _playback_resolvers:
        playback = resolver.resolve_playback(
            type_data=type_data,
            user_id=user_id,
        )
        if playback is not None:
            return playback
    return None


def register_external_attachment_reference_resolver(
    resolver: ExternalAttachmentReferenceResolver,
) -> None:
    """Register an external attachment reference resolver."""
    _reference_resolvers.append(resolver)


def resolve_external_attachment_reference(
    *,
    type_data: dict[str, Any],
) -> ExternalAttachmentReference | None:
    """Resolve a stable reference using the first matching resolver."""
    for resolver in _reference_resolvers:
        reference = resolver.resolve_reference(type_data=type_data)
        if reference is not None:
            return reference
    return None
