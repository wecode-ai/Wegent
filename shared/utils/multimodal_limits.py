# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Multimodal pipeline size thresholds — single source of truth.

This module centralizes every size constant used by the multimodal video/image
pipeline (KB converter + backend staging gateway). It is a pure-constants
module that lives in ``shared`` (the bottom layer); both ``app`` (backend) and
``knowledge_doc_converter`` depend on it — never the reverse.

Provider-neutral naming: the constants describe the *staging protocol* limits
(``REMOTE_MEDIA_*``) rather than a specific vendor, so the open-source build
can ship them without coupling to any private gateway. Internal deployments
plug a concrete ``MediaStagingProvider`` (e.g. GCS) that honors these limits.

Design notes:
- ``REMOTE_MEDIA_SIMPLE_MAX_BYTES`` / ``REMOTE_MEDIA_MAX_FILE_SIZE`` are staging
  protocol facts. They were centralized here so the converter (which has no
  ``app`` dependency) can import the same ceiling without an HTTP round-trip.
- ``IMAGE_MAX_BYTES`` / ``VIDEO_REMOTE_UPLOAD_THRESHOLD`` are *derived* from
  ``REMOTE_MEDIA_SIMPLE_MAX_BYTES`` (image always fits simple upload;
  simple/resumable threshold equals the simple ceiling). Declaring them by
  assignment makes the relationship structural, so no redundant assertion is
  needed.
- ``IMAGE_BASE64_INLINE_MAX_BYTES`` / ``VIDEO_MAX_BYTES`` are *independent*
  product limits (Gemini inline cap / pipeline hard cap).
- This module intentionally does NOT couple to the general upload limits
  ``MAX_UPLOAD_VIDEO_FILE_SIZE_MB`` (backend) / ``MAX_VIDEO_FILE_SIZE``
  (frontend) — those are owned by other code. The numeric coincidence (all
  1 GB) is not a contract; each side evolves independently.
"""

# ── Staging protocol facts (base constants) ──────────────────────────
# The default staging protocol exposes a simple-upload ceiling and a resumable
# hard limit. Concrete providers (GCS, S3, ...) honor these defaults; named
# neutrally so the open-source build carries no vendor coupling.
REMOTE_MEDIA_SIMPLE_MAX_BYTES = 100 * 1024 * 1024  # 100 MB — simple upload ceiling
REMOTE_MEDIA_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB — resumable hard limit

# ── Multimodal pipeline thresholds ───────────────────────────────────
# Independent: Gemini inline base64 limit.
IMAGE_BASE64_INLINE_MAX_BYTES = 20 * 1024 * 1024  # 20 MB

# Derived: image always fits within the simple-upload ceiling.
IMAGE_MAX_BYTES = REMOTE_MEDIA_SIMPLE_MAX_BYTES

# Derived: videos below this use simple upload; at/above this use resumable.
VIDEO_REMOTE_UPLOAD_THRESHOLD = REMOTE_MEDIA_SIMPLE_MAX_BYTES

# Independent: multimodal pipeline hard cap (product limit).
VIDEO_MAX_BYTES = 1024 * 1024 * 1024  # 1 GB

# Single meaningful assertion: the pipeline video cap must not exceed the
# resumable hard limit, otherwise resumable uploads of validly-sized videos
# would fail at the staging provider.
assert (
    VIDEO_MAX_BYTES <= REMOTE_MEDIA_MAX_FILE_SIZE
), "VIDEO_MAX_BYTES exceeds REMOTE_MEDIA_MAX_FILE_SIZE (2 GB hard limit)"
