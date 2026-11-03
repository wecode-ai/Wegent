"""Converter service settings using pydantic-settings.

Configuration is loaded from environment variables or .env file.
All conversion-related settings that were previously in backend config.py
now live here.
"""

from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse, urlunparse

from pydantic import Field
from pydantic_settings import BaseSettings

if TYPE_CHECKING:
    from shared.event_reporting.config import EventReporterConfig


def _inject_redis_password(url: str, password: str) -> str:
    """Inject password into a Redis URL if not already present.

    Supports standard Redis URL format: redis://[:password@]host:port/db
    If password is empty or the URL already contains credentials, returns unchanged.
    """
    if not password:
        return url
    parsed = urlparse(url)
    # Already has credentials in URL, keep as-is
    if parsed.password:
        return url
    # Inject password: redis://host -> redis://:password@host
    netloc = f":{password}@{parsed.hostname}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


class ConverterSettings(BaseSettings):
    """Knowledge document converter service settings.

    REDIS_PASSWORD is applied to all Redis URLs (CELERY_BROKER_URL,
    CELERY_RESULT_BACKEND, REDIS_URL) when set. If empty or not configured,
    no password authentication is used.
    """

    # ---- Backend Callback ----
    BACKEND_BASE_URL: str = "http://backend:8000"
    BACKEND_INTERNAL_TOKEN: str = ""

    # ---- Redis Password ----
    # Applied to all Redis URLs when set; empty = no password authentication
    REDIS_PASSWORD: str = ""

    # ---- Celery ----
    CELERY_BROKER_URL: str = "redis://redis:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://redis:6379/1"
    KNOWLEDGE_CONVERSION_QUEUE: str = "knowledge_conversion"

    # ---- Distributed Lock (Redis) ----
    # Constraint: lock_timeout > CONVERSION_TASK_TIME_LIMIT
    REDIS_URL: str = "redis://redis:6379/0"
    KNOWLEDGE_CONVERSION_LOCK_TIMEOUT_SECONDS: int = 12000
    KNOWLEDGE_CONVERSION_LOCK_EXTEND_INTERVAL_SECONDS: int = 60
    KNOWLEDGE_CONVERSION_LOCK_MAX_RETRIES: int = 2
    KNOWLEDGE_CONVERSION_LOCK_RETRY_DELAY_SECONDS: int = 30

    # ---- MinerU ----
    MINERU_API_BASE_URL: str = ""
    MINERU_BACKEND: str = "pipeline"
    MINERU_PARSE_METHOD: str = "ocr"
    MINERU_LANG_LIST: str = "ch"
    MINERU_FORMULA_ENABLE: bool = True
    MINERU_TABLE_ENABLE: bool = True
    MINERU_POLL_INTERVAL_SECONDS: int = 3
    MINERU_MAX_WAIT_SECONDS: int = 600

    # ---- MinerU HTTP Request ----
    # Timeout in seconds for MinerU API HTTP requests
    MINERU_SUBMIT_TIMEOUT_SECONDS: int = 60  # Task submission request timeout
    MINERU_STATUS_TIMEOUT_SECONDS: int = 10  # Status polling request timeout
    MINERU_DOWNLOAD_TIMEOUT_SECONDS: int = 120  # Result download request timeout
    # Maximum consecutive errors before aborting the polling loop
    MINERU_MAX_CONSECUTIVE_ERRORS: int = 5
    # Seconds to wait before retrying after a transient polling error
    MINERU_ERROR_RETRY_INTERVAL_SECONDS: int = 3

    # ---- S3 (image upload) ----
    WORKER_CONVERSION_S3_ENABLED: bool = False
    WORKER_CONVERSION_S3_ENDPOINT: str = ""
    WORKER_CONVERSION_S3_ACCESS_KEY: str = ""
    WORKER_CONVERSION_S3_SECRET_KEY: str = ""
    WORKER_CONVERSION_S3_BUCKET_NAME: str = ""
    WORKER_CONVERSION_S3_REGION_NAME: str = "us-east-1"

    # ---- Task Timeout ----
    # Constraint chain (cross-service):
    #   soft_time_limit < time_limit < lock_timeout <= stale_threshold (backend)
    #   9000s            10000s        12000s          12000s
    CONVERSION_TASK_SOFT_TIME_LIMIT: int = 9000  # 150 min, soft limit (catchable)
    CONVERSION_TASK_TIME_LIMIT: int = 10000  # ~167 min, hard limit (SIGKILL)

    # ---- Logging ----
    LOG_FILE_ENABLED: bool = True  # Enable file logging
    LOG_DIR: str = "./logs"  # Directory for log files
    LOG_LEVEL: str = "INFO"  # Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)

    # ---- Prometheus Metrics ----
    PROMETHEUS_ENABLED: bool = False  # Enable Prometheus metrics server
    PROMETHEUS_PORT: int = 9090  # Port for Prometheus metrics endpoint
    PROMETHEUS_PATH: str = "/metrics"  # URL path for Prometheus metrics endpoint

    # ---- Knowledge Event Reporting ----
    EVENT_REPORTING_ENABLED: Any = False
    EVENT_KAFKA_BOOTSTRAP_SERVERS: Any = ""
    EVENT_KAFKA_TOPIC: Any = "knowledge-events-v1"
    EVENT_KAFKA_ENVIRONMENT: Any = ""
    EVENT_KAFKA_CLIENT_ID: Any = ""
    EVENT_KAFKA_ACKS: Any = "all"
    EVENT_KAFKA_COMPRESSION_TYPE: Any = "lz4"
    EVENT_KAFKA_LINGER_MS: Any = 20
    EVENT_KAFKA_REQUEST_TIMEOUT_MS: Any = 5_000
    EVENT_KAFKA_DELIVERY_TIMEOUT_MS: Any = 5_000
    EVENT_KAFKA_QUEUE_MAX_BYTES: Any = 16 * 1024 * 1024
    EVENT_KAFKA_EVENT_MAX_BYTES: Any = 8 * 1024
    EVENT_KAFKA_SHUTDOWN_TIMEOUT_MS: Any = 8_000
    EVENT_KAFKA_SECURITY_PROTOCOL: Any = "PLAINTEXT"
    EVENT_KAFKA_SASL_MECHANISM: Any = "PLAIN"
    EVENT_KAFKA_SASL_USERNAME: Any = Field(default="", repr=False)
    EVENT_KAFKA_SASL_PASSWORD: Any = Field(default="", repr=False)
    EVENT_KAFKA_SSL_CAFILE: Any = ""

    # ---- Multimodal Analysis (video/image → Gemini → Markdown) ----
    # One pipeline, one model: media_type (video|image) distinguishes inside the
    # task. Video always stages via a MediaStagingProvider; image uses inline
    # base64 when ≤ MULTIMODAL_INLINE_MAX_BYTES, else stages (shared with video).
    # No platform fallback api_key (single source = KB's
    # multimodalAnalysisModelRef resolved at execution time).
    MULTIMODAL_ENABLED: bool = False  # Master switch (default off in open-source)
    MULTIMODAL_QUEUE: str = "knowledge_multimodal_conversion"
    MULTIMODAL_GEMINI_TEMPERATURE: float = 0.2
    MULTIMODAL_RETRY_MAX: int = 1
    MULTIMODAL_RETRY_COUNTDOWN_SECONDS: int = 60
    MULTIMODAL_DOWNLOAD_CHUNK_BYTES: int = 1024 * 1024  # 1 MiB
    # Image size threshold: ≤ this → inline base64; > this → staging.
    MULTIMODAL_INLINE_MAX_BYTES: int = 20 * 1024 * 1024  # 20 MB
    # Image hard cap (PermanentError above this).
    MULTIMODAL_IMAGE_MAX_BYTES: int = 100 * 1024 * 1024  # 100 MB
    # Video simple-vs-resumable threshold and hard cap.
    MULTIMODAL_VIDEO_SIMPLE_UPLOAD_MAX_BYTES: int = 100 * 1024 * 1024  # 100 MB
    MULTIMODAL_VIDEO_MAX_BYTES: int = 1024 * 1024 * 1024  # 1 GB
    # Gemini output token budget: video scenes are longer than single images.
    MULTIMODAL_VIDEO_GEMINI_MAX_OUTPUT_TOKENS: int = 8192
    MULTIMODAL_IMAGE_GEMINI_MAX_OUTPUT_TOKENS: int = 4096
    # Task timeouts (declared on the single task decorator — Celery limits are
    # per-task, not per-message). The decorator uses the larger VIDEO values;
    # image enforces a shorter soft deadline internally via time.monotonic().
    MULTIMODAL_TASK_SOFT_TIME_LIMIT: int = 1800  # video soft timeout (s)
    MULTIMODAL_TASK_TIME_LIMIT: int = 2000  # hard limit (s)
    MULTIMODAL_IMAGE_SOFT_TIME_LIMIT: int = 300  # image in-task soft deadline (s)
    # Download timeouts: video (large CDN) vs image (attachment endpoint).
    MULTIMODAL_DOWNLOAD_TIMEOUT_SECONDS: int = 300
    MULTIMODAL_IMAGE_DOWNLOAD_TIMEOUT_SECONDS: int = 120
    # Staging simple upload ceiling — re-exported for coordinator size routing.
    MULTIMODAL_GCS_SIMPLE_MAX_BYTES: int = 100 * 1024 * 1024  # 100 MB

    model_config = {"env_file": ".env", "extra": "ignore"}

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Apply REDIS_PASSWORD to all Redis URLs
        pwd = self.REDIS_PASSWORD
        if pwd:
            self.CELERY_BROKER_URL = _inject_redis_password(self.CELERY_BROKER_URL, pwd)
            self.CELERY_RESULT_BACKEND = _inject_redis_password(
                self.CELERY_RESULT_BACKEND, pwd
            )
            self.REDIS_URL = _inject_redis_password(self.REDIS_URL, pwd)

    def event_reporter_config(self, service_name: str) -> "EventReporterConfig":
        """Build reporter config from the converter's resolved settings."""
        from shared.event_reporting.config import EventReporterConfig

        return EventReporterConfig.from_mapping(self.__dict__, service_name)


settings = ConverterSettings()
