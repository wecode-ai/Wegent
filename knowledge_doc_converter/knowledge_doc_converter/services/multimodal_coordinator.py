# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Media staging coordinator for multimodal analysis.

Thin facade over a :class:`MediaStagingProvider`. The converter no longer talks
directly to a vendor GCS gateway; instead it delegates upload/delete to the
pluggable provider selected from the task's ``media_staging_config``. This keeps
the converter free of vendor credentials and lets the open-source build ship a
NoOp default while internal deployments inject a concrete provider.

Error classification: provider failures are mapped to the pipeline's
Transient/Permanent categories so the task's retry decision stays uniform.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from knowledge_doc_converter.services.errors import (
    PermanentError,
    TransientError,
)
from knowledge_doc_converter.services.media_staging import (
    MediaStagingProvider,
    build_staging_provider,
)

logger = logging.getLogger(__name__)


class MultimodalConversionCoordinator:
    """Coordinate media upload/delete via a pluggable staging provider."""

    def upload(
        self,
        *,
        tmp_path: str,
        filename: str,
        content_type: str,
        media_type: str,
        staging_provider: MediaStagingProvider,
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Stage a local media file and return ``{uri, object_name}``.

        Raises :class:`PermanentError` / :class:`TransientError` per the
        provider's failure mode (NoOp raises PermanentError immediately).
        """
        try:
            descriptor = staging_provider.upload(
                local_path=tmp_path,
                mime_type=content_type,
                original_filename=filename,
                media_type=media_type,
                timeout_seconds=timeout_seconds,
            )
        except PermanentError:
            raise
        except TransientError:
            raise
        except Exception as exc:
            # Unknown provider failure → treat as transient (network, gateway
            # hiccup) so the task retries once before failing fast.
            raise TransientError(
                "staging_upload_failed", f"Media staging upload failed: {exc}"
            ) from exc

        uri = descriptor.get("uri")
        object_name = descriptor.get("object_name")
        if not uri or not object_name:
            raise PermanentError(
                "staging_invalid_descriptor",
                f"Staging provider returned an incomplete descriptor: {descriptor!r}",
            )
        return {"gs_url": uri, "object_name": object_name}

    def delete(
        self,
        *,
        staging_provider: MediaStagingProvider,
        object_name: Optional[str],
    ) -> None:
        """Best-effort delete of a staged object. Never raises."""
        if not object_name:
            return
        try:
            staging_provider.delete(object_name=object_name)
        except Exception as exc:  # noqa: BLE001 — cleanup must never raise
            logger.warning(
                "Media staging delete failed object_name=%s error=%s",
                object_name,
                exc,
            )


# Module-level singleton.
multimodal_conversion_coordinator = MultimodalConversionCoordinator()


def get_staging_provider(
    media_staging_config: Optional[Dict[str, Any]],
) -> MediaStagingProvider:
    """Convenience wrapper around ``build_staging_provider``."""
    return build_staging_provider(media_staging_config)
