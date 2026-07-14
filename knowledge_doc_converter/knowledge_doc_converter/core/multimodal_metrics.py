# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Prometheus metrics for the multimodal analysis pipeline (video + image).

Covers BOTH video and image. ``media_type`` (video|image) and ``delivery``
(staging|inline) labels distinguish the two paths within one pipeline.
"""

from prometheus_client import Counter, Gauge, Histogram

# Total conversions by outcome; delivery distinguishes staging vs inline.
MULTIMODAL_CONVERSIONS_TOTAL = Counter(
    "converter_multimodal_conversions_total",
    "Multimodal conversions by result/media/delivery",
    ["result", "model_type", "model", "file_extension", "media_type", "delivery"],
)

MULTIMODAL_DURATION_SECONDS = Histogram(
    "converter_multimodal_duration_seconds",
    "Total multimodal conversion wall-clock duration",
    ["file_extension", "media_type"],
)

MULTIMODAL_STAGE_DURATION_SECONDS = Histogram(
    "converter_multimodal_stage_duration_seconds",
    "Per-stage duration (download/staging_upload/gemini)",
    ["stage", "file_extension", "media_type"],
)

MULTIMODAL_INPUT_BYTES = Histogram(
    "converter_multimodal_input_bytes",
    "Input media size in bytes",
    ["file_extension", "media_type"],
    buckets=(1048576, 10485760, 52428800, 104857600),
)

MULTIMODAL_OUTPUT_BYTES = Histogram(
    "converter_multimodal_output_bytes",
    "Output Markdown size in bytes",
    ["file_extension", "media_type"],
    buckets=(5120, 20480, 102400, 524288),
)

MULTIMODAL_GEMINI_BLOCKED_TOTAL = Counter(
    "converter_multimodal_gemini_blocked_total",
    "Gemini responses blocked by safety",
    ["block_reason", "media_type"],
)

MULTIMODAL_GEMINI_ERRORS_TOTAL = Counter(
    "converter_multimodal_gemini_errors_total",
    "Gemini call errors by type",
    ["error_type", "media_type"],
)

MULTIMODAL_ACTIVE = Gauge(
    "converter_multimodal_active",
    "Multimodal conversions in progress",
    multiprocess_mode="livesum",
)

# Staging operations — shared by video (always) and large images (> inline).
MULTIMODAL_STAGING_OPERATIONS_TOTAL = Counter(
    "converter_multimodal_staging_operations_total",
    "Media staging operation results (video + large images)",
    ["op", "result", "media_type"],
)
