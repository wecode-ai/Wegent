# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Fetch the runtime multimodal model config at task execution time.

The standalone converter microservice has no DB access and no decryption
credentials. Instead of carrying the decrypted model config (api_key,
default_headers) on the Celery broker, the converter calls the backend's
internal ``/api/internal/model-config/resolve`` endpoint at execution time with
just the model reference + uploader identity, and receives the already-decrypted
runtime config. This keeps the broker free of any sensitive config (P5 fix).

Extracted as a standalone class (not a patch on ContentFetcher) so the
open-source build owns the implementation directly.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

import httpx

from knowledge_doc_converter.config import settings
from knowledge_doc_converter.core.metrics import (
    record_http_request_failed,
    record_http_request_success,
)

logger = logging.getLogger(__name__)


class ModelConfigFetcher:
    """Resolve the runtime model config (api_key decrypted) at execution time."""

    def __init__(self, base_url: str, headers: Dict[str, str]):
        self.base_url = base_url
        # Ensure JSON content-type for POST bodies.
        self.headers = {**headers, "Content-Type": "application/json"}

    def fetch(
        self,
        *,
        path: str,
        model_ref: Dict[str, Any],
        uploader_id: int,
        uploader_name: Optional[str],
        media_type: str,
    ) -> Optional[Dict[str, Any]]:
        """POST to the backend model-config resolve endpoint.

        Returns the resolved runtime config dict, or None if the response did
        not carry a ``runtime_config`` field. Raises ``httpx.HTTPStatusError``
        on a non-2xx response (4xx = permanent misconfiguration, 5xx =
        transient backend outage — the caller classifies).
        """
        url = f"{self.base_url}{path}"
        payload = {
            "model_ref": model_ref,
            "uploader_id": uploader_id,
            "uploader_name": uploader_name,
            "media_type": media_type,
        }
        try:
            resp = httpx.post(url, json=payload, headers=self.headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as exc:
            record_http_request_failed("model_config_resolve")
            detail = ""
            try:
                detail = exc.response.text
            except Exception:  # noqa: BLE001 — best-effort detail extraction
                pass
            logger.error(
                "model-config resolve failed path=%s status=%s detail=%s",
                path,
                exc.response.status_code if exc.response is not None else "?",
                detail[:500],
            )
            raise
        except Exception:
            record_http_request_failed("model_config_resolve")
            raise
        record_http_request_success("model_config_resolve")
        cfg = data.get("runtime_config") if isinstance(data, dict) else None
        if not isinstance(cfg, dict):
            logger.warning(
                "model-config resolve response had no runtime_config field: "
                "path=%s body=%s",
                path,
                data,
            )
            return None
        logger.info(
            "Resolved model config path=%s model_id=%s media_type=%s",
            path,
            cfg.get("model_id"),
            media_type,
        )
        return cfg

    def fetch_video_download_url(self, path: str) -> Optional[str]:
        """Resolve a fresh short-lived video download URL via the backend.

        GET ``{base_url}{path}`` → ``{"url": "...", "expires_in": ...}``.
        Returns the URL string, or None if the backend could not resolve one.
        """
        url = f"{self.base_url}{path}"
        try:
            resp = httpx.get(url, headers=self.headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            record_http_request_failed("video_download_url")
            raise
        record_http_request_success("video_download_url")
        video_url = data.get("url") if isinstance(data, dict) else None
        if not video_url:
            logger.warning(
                "video-download-url response had no url field: path=%s body=%s",
                path,
                data,
            )
            return None
        logger.info(
            "Resolved video download url path=%s expires_in=%s",
            path,
            data.get("expires_in"),
        )
        return video_url


# Module-level singleton. Built lazily on first use so importing this module
# never triggers settings/network access at import time.
_model_config_fetcher: Optional[ModelConfigFetcher] = None


def get_model_config_fetcher() -> ModelConfigFetcher:
    """Return the module-level ModelConfigFetcher singleton."""
    global _model_config_fetcher
    if _model_config_fetcher is None:
        headers = {"Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}"}
        _model_config_fetcher = ModelConfigFetcher(
            base_url=settings.BACKEND_BASE_URL, headers=headers
        )
    return _model_config_fetcher
