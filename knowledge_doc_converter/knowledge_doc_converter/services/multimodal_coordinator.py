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
import os
from typing import Any, Dict, Optional

import httpx

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

    def upload_via_proxy(
        self,
        *,
        tmp_path: str,
        filename: str,
        content_type: str,
        gcs_upload_path: str,
        gcs_resumable_base_path: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Upload a local file to a staging proxy (e.g. backend GCS proxy).

        Used by internal deployments where the converter has no direct cloud
        credentials — it streams the file to a backend internal endpoint which
        proxies the upload to the staging provider (GCS gateway, S3, etc.).

        Returns ``{gs_url, object_name}``.
        """
        from knowledge_doc_converter.config import settings
        from knowledge_doc_converter.services.errors import (
            PermanentError,
            TransientError,
        )

        base_url = settings.BACKEND_BASE_URL
        headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
        }
        upload_url = f"{base_url}{gcs_upload_path}"
        file_size = os.path.getsize(tmp_path)

        try:
            with open(tmp_path, "rb") as f:
                resp = httpx.post(
                    upload_url,
                    data={"filename": filename, "content_type": content_type},
                    files={"file": (filename, f, content_type)},
                    headers=headers,
                    timeout=timeout_seconds or 300,
                )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code if exc.response is not None else 0
            if status == 413:
                raise PermanentError(
                    "staging_file_too_large",
                    f"Staging proxy rejected file (too large): {status}",
                ) from exc
            if status in (401, 403):
                # Auth/permission errors never succeed on retry — classify as
                # permanent so the worker stops instead of wasting retries.
                raise PermanentError(
                    "staging_auth_error",
                    f"Staging proxy auth/permission error (status={status})",
                ) from exc
            if 500 <= status < 600:
                raise TransientError(
                    "staging_proxy_server",
                    f"Staging proxy server error (status={status})",
                ) from exc
            raise TransientError(
                "staging_proxy_client",
                f"Staging proxy client error (status={status})",
            ) from exc
        except Exception as exc:
            raise TransientError(
                "staging_upload_failed", f"Media staging upload failed: {exc}"
            ) from exc

        gs_url = data.get("gs_url")
        object_name = data.get("object_name")
        if not gs_url or not object_name:
            raise PermanentError(
                "staging_invalid_response",
                f"Staging proxy returned incomplete response: {data!r}",
            )
        return {"gs_url": gs_url, "object_name": object_name}

    def delete_via_proxy(
        self,
        *,
        gcs_delete_path: str,
        object_name: str,
    ) -> None:
        """Best-effort delete of a staged object via a proxy. Never raises."""
        from knowledge_doc_converter.config import settings

        base_url = settings.BACKEND_BASE_URL
        headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
        }
        delete_url = f"{base_url}{gcs_delete_path}"
        try:
            httpx.post(
                delete_url,
                data={"object_name": object_name},
                headers=headers,
                timeout=30,
            )
        except Exception as exc:  # noqa: BLE001 — cleanup must never raise
            logger.warning(
                "Staging proxy delete failed object_name=%s error=%s",
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
