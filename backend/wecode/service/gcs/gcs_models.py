# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""GCS gateway data classes, exceptions, and constants.

Extracted from ``gcs_gateway_service.py`` to keep each module under the
file-size / function-length limits (AGENTS.md). Constants that were
hardcoded literals are now sourced from ``multimodal_settings`` so they
can be overridden via environment variables without code changes.
"""

from dataclasses import dataclass
from typing import Literal, Optional

from wecode.config.multimodal_config import multimodal_settings

# ── Gateway connection constants (configurable via env) ──────────────
GCS_GATEWAY_BASE = multimodal_settings.GCS_GATEWAY_BASE
GCS_APPKEY = multimodal_settings.GCS_APPKEY
GCS_MODEL_ID = multimodal_settings.GCS_MODEL_ID
GCS_TYPE = multimodal_settings.GCS_TYPE
GCS_MESSAGE = multimodal_settings.GCS_MESSAGE

# ── Protocol constants ───────────────────────────────────────────────
# REMOTE_MEDIA_SIMPLE_MAX_BYTES / REMOTE_MEDIA_MAX_FILE_SIZE are imported from
# shared.utils.multimodal_limits (single source of truth, shared with the
# converter which has no ``app`` dependency).
GCS_CHUNK_SIZE = 8 * 1024 * 1024  # 8 MiB
GCS_TIMEOUT = 120  # seconds, for single-file / chunk uploads
GCS_RESUMABLE_TIMEOUT = 30  # seconds, for init/query/cancel
GCS_MAX_RETRIES = 3


# ── Data classes ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class GcsUploadResult:
    """Result of a simple (single-request) upload."""

    object_name: str
    gs_url: str
    request_id: Optional[str]
    file_size: int
    content_type: str


@dataclass(frozen=True)
class GcsInitResult:
    """Result of a resumable upload init."""

    session_uri: str
    object_name: str
    bucket: str
    total_size: int
    chunk_size: int
    content_type: str


@dataclass(frozen=True)
class GcsChunkResult:
    """Result of a resumable put_chunk call."""

    status: Literal["continue", "done"]
    next_offset: Optional[int]
    object_name: Optional[str]
    gs_url: Optional[str]
    request_id: Optional[str]


@dataclass(frozen=True)
class GcsQueryResult:
    """Result of a resumable query call."""

    status: Literal["done", "in_progress", "empty"]
    received_byte: Optional[int]
    next_offset: Optional[int]
    object_name: Optional[str]
    gs_url: Optional[str]


# ── Exceptions ───────────────────────────────────────────────────────


class GcsGatewayError(Exception):
    """Unified GCS gateway error with error_code for endpoint-layer mapping."""

    def __init__(self, error_code: str, message: str, *, code: Optional[int] = None):
        self.error_code = error_code
        self.gateway_code = code
        super().__init__(message)


class GcsSessionInvalid(GcsGatewayError):
    """Resumable session URI is expired or invalid; client must re-init."""

    def __init__(self, message: str = "Session URI is invalid or expired"):
        super().__init__("gcs_session_invalid", message)
