# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal multimodal analysis configuration (video/image Gemini pipeline).

Kept out of the open-source ``app.core.config.Settings`` so the open-source
backend can run with zero multimodal fields. Internal services import
``multimodal_settings`` instead of the open-source ``settings`` for these
multimodal-specific knobs; generic settings (e.g. ``REDIS_URL``) are still
sourced from the open-source ``app.core.config.settings``.
"""

from pydantic_settings import BaseSettings


class MultimodalSettings(BaseSettings):
    """Configuration for the internal multimodal (video/image) Gemini pipeline."""

    # Global kill switch for the knowledge-base multimodal (video/image Gemini)
    # pipeline. Defaults to False — the pipeline is opt-in. When False,
    # conversion_pipeline never classifies a file as "multimodal", so no
    # multimodal dispatch / Gemini conversion runs anywhere (create / update /
    # reindex / transfer). Already-converted multimodal documents (with a
    # converted Markdown attachment) keep re-indexing normally via the
    # converted-attachment path. Set KNOWLEDGE_MULTIMODAL_ENABLED=true in .env
    # to enable the pipeline.
    KNOWLEDGE_MULTIMODAL_ENABLED: bool = False

    # Knowledge-base multimodal analysis pipeline (video + image share one
    # queue/model). The converter microservice has no TAuth2 credentials, so it
    # proxies GCS upload through this backend internal endpoint. Staged GCS
    # objects are never deleted manually — the bucket lifecycle (age > 1 day)
    # reaps them, so no delete proxy endpoint exists.
    MULTIMODAL_GCS_UPLOAD_PATH: str = "/api/internal/multimodal-gcs/upload"
    # Backend internal endpoint the converter calls to resolve the multimodal
    # analysis model ref into a runtime config (api_key decrypted).
    MULTIMODAL_MODEL_CONFIG_RESOLVE_PATH: str = "/api/internal/model-config/resolve"
    # Separate Celery queue so multimodal conversions never block MinerU.
    KNOWLEDGE_MULTIMODAL_CONVERSION_QUEUE: str = "knowledge_multimodal_conversion"

    # GCS gateway connection parameters (i.aigc.weibo.com). Centralized here so
    # they can be overridden via environment variables without code changes.
    GCS_GATEWAY_BASE: str = "http://i.aigc.weibo.com"
    GCS_APPKEY: str = "2720640420"
    GCS_MODEL_ID: str = "gcs-standard"
    GCS_TYPE: str = "google-cloud"
    GCS_MESSAGE: str = "wegent-gemini-video"

    # Per-process concurrent KB video download connection cap. Each download
    # holds an upstream httpx connection + a downstream streaming response for
    # the full (potentially multi-minute, multi-GB) transfer. Without a cap a
    # single user could exhaust backend file descriptors / connections.
    MAX_CONCURRENT_VIDEO_DOWNLOADS: int = 8

    class Config:
        env_file = ".env"
        extra = "ignore"


multimodal_settings = MultimodalSettings()
