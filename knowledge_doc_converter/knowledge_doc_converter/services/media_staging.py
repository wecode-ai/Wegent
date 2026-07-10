# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Pluggable media staging provider for multimodal (video/large-image) analysis.

Gemini consumes large media (video, and images above the inline base64
threshold) via a model-readable URI (``gs://...`` for the Google Gemini SDK).
The converter itself has no vendor credentials and should not be coupled to any
specific object-storage gateway. This module defines a provider-neutral
abstraction and a default ``NoOpStagingProvider`` that the open-source build
ships.

- Image path: small images go inline base64 (no staging needed); large images
  stage via the provider.
- Video path: always stages via the provider. The default NoOp provider rejects
  video up-front with a ``PermanentError("video_staging_not_configured")`` so
  the task fails fast and notifies the backend with a clear message — the
  pipeline framework is fully wired, only the concrete staging implementation
  is left as a stub.

Internal deployments inject a concrete provider (e.g. a GCS gateway client)
through ``build_staging_provider`` when ``media_staging_config`` carries the
provider type + credentials.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from knowledge_doc_converter.services.errors import PermanentError

logger = logging.getLogger(__name__)


@runtime_checkable
class MediaStagingProvider(Protocol):
    """Pluggable provider for staging large media for model consumption."""

    def upload(
        self,
        *,
        local_path: str,
        mime_type: str,
        original_filename: str,
        media_type: str,
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Upload the local file and return a descriptor for the staged object.

        The descriptor must carry at least:
        - ``uri``: a model-readable URI (e.g. ``gs://bucket/object``).
        - ``object_name``: an identifier the provider can later delete.

        Implementations may carry additional fields (e.g. resumable session
        info) as long as those two are present.
        """
        ...

    def delete(self, *, object_name: str) -> None:
        """Delete a staged object. Best-effort: never raises."""
        ...


class NoOpStagingProvider:
    """Default staging provider — rejects all uploads with a clear error.

    The open-source build ships no vendor staging gateway. Video analysis
    (which always requires staging) is therefore rejected up-front with a
    ``PermanentError`` so the task fails fast and the backend receives a clear
    "video staging not configured" message. The rest of the pipeline
    (state machine, callback, metrics, prompt) is fully wired; only this
    provider implementation is a stub to be replaced by a concrete provider.
    """

    def upload(
        self,
        *,
        local_path: str,
        mime_type: str,
        original_filename: str,
        media_type: str,
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        raise PermanentError(
            "video_staging_not_configured",
            "No media staging provider configured (set media_staging_config "
            "with a concrete provider to enable video / large-image analysis)",
        )

    def delete(self, *, object_name: str) -> None:
        # Nothing was ever uploaded — no-op.
        return None


def build_staging_provider(
    media_staging_config: Optional[Dict[str, Any]],
) -> MediaStagingProvider:
    """Build a concrete staging provider from task-provided config.

    The open-source default returns ``NoOpStagingProvider`` for any config the
    core does not recognize. Internal deployments register additional provider
    types here (e.g. ``"gcs_gateway"``) by extending this factory — the core
    task only depends on the Protocol above.

    ``media_staging_config`` is an opaque dict forwarded from the backend's
    dispatch context; the core pipeline never inspects its contents.
    """
    if not media_staging_config:
        return NoOpStagingProvider()

    provider_type = (media_staging_config.get("type") or "").lower()
    # The open-source build ships no concrete providers. Register additional
    # provider types in an extension module and wire them here. Unknown types
    # fall through to NoOp so the failure surfaces a clear message rather than
    # an import error.
    if provider_type:
        logger.warning(
            "Unknown media staging provider type %r — falling back to NoOp",
            provider_type,
        )
    return NoOpStagingProvider()
