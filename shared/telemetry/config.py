# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry configuration module.

Provides centralized configuration loading from environment variables
for all Wegent services. This is the single source of truth for OTEL
configuration across backend, executor, and executor_manager modules.

Environment Variables:
    OTEL_ENABLED: Enable/disable OpenTelemetry (default: false)
    OTEL_SERVICE_NAME: Service name for tracing (default: wegent-service)
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP gRPC endpoint (default: http://otel-collector:4317)
    OTEL_TRACES_SAMPLER_ARG: Sampling ratio 0.0-1.0 (default: 1.0)
    OTEL_METRICS_ENABLED: Enable/disable metrics export (default: false)
    OTEL_CAPTURE_REQUEST_HEADERS: Capture HTTP request headers (default: false)
    OTEL_CAPTURE_REQUEST_BODY: Capture HTTP request body (default: false)
    OTEL_CAPTURE_RESPONSE_HEADERS: Capture HTTP response headers (default: false)
    OTEL_CAPTURE_RESPONSE_BODY: Capture HTTP response body (default: false)
    OTEL_MAX_BODY_SIZE: Maximum body size to capture in bytes (default: 4096, max: 1048576)
    OTEL_EXCLUDED_URLS: Comma-separated list of URL patterns to exclude from tracing (default: health,metrics,docs)
    OTEL_INCLUDED_URLS: Comma-separated list of URL patterns to include (whitelist mode, empty means all)
    OTEL_DISABLE_SEND_RECEIVE_SPANS: Disable internal http.send/http.receive spans for SSE/streaming (default: true)
        This is the industry standard approach to reduce noise from streaming endpoints like /api/chat/stream
        where each chunk would otherwise create a separate span. See OpenTelemetry ASGI instrumentation docs.
"""

import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# Default URL patterns to exclude from tracing (health checks, docs, static assets)
DEFAULT_EXCLUDED_URLS = [
    "/",  # Root path health check
    "/health",
    "/healthz",
    "/ready",
    "/readyz",
    "/livez",
    "/metrics",
    "/api/docs",
    "/api/openapi.json",
    "/api/quota/*",
    "/api/executors/tasks/dispatch",  # Task dispatch endpoint - uses internal trace
    "/favicon.ico",
]


@dataclass
class OtelConfig:
    """
    OpenTelemetry configuration dataclass.

    This class holds all OTEL configuration values loaded from environment
    variables. Use get_otel_config() to get a singleton instance.
    """

    enabled: bool
    service_name: str
    otlp_endpoint: str
    sampler_ratio: float
    metrics_enabled: bool
    capture_request_headers: bool
    capture_request_body: bool
    capture_response_headers: bool
    capture_response_body: bool
    max_body_size: int  # Maximum body size to capture in bytes
    excluded_urls: List[str] = field(
        default_factory=list
    )  # URL patterns to exclude (blacklist)
    included_urls: List[str] = field(
        default_factory=list
    )  # URL patterns to include (whitelist, empty means all)
    disable_send_receive_spans: bool = (
        True  # Disable internal http.send/http.receive spans for SSE/streaming
    )


# Cached configuration instance
_otel_config: Optional[OtelConfig] = None


def get_otel_config(service_name_override: Optional[str] = None) -> OtelConfig:
    """
    Get OpenTelemetry configuration from environment variables.

    This function returns a cached OtelConfig instance. The configuration
    is loaded once from environment variables and reused for subsequent calls.

    Args:
        service_name_override: Optional service name to override the default.
                              Only used on first call when config is created.

    Returns:
        OtelConfig: Configuration dataclass with all OTEL settings

    Example:
        >>> config = get_otel_config("wegent-backend")
        >>> if config.enabled:
        ...     init_telemetry(config)
    """
    global _otel_config

    if _otel_config is None:
        default_service_name = service_name_override or os.getenv(
            "OTEL_SERVICE_NAME", "wegent-service"
        )

        # Parse excluded URLs from environment variable
        excluded_urls_env = os.getenv("OTEL_EXCLUDED_URLS", "")
        if excluded_urls_env:
            excluded_urls = [
                url.strip() for url in excluded_urls_env.split(",") if url.strip()
            ]
        else:
            # Use default excluded URLs if not specified
            excluded_urls = DEFAULT_EXCLUDED_URLS.copy()

        # Parse included URLs from environment variable (whitelist mode)
        included_urls_env = os.getenv("OTEL_INCLUDED_URLS", "")
        included_urls = [
            url.strip() for url in included_urls_env.split(",") if url.strip()
        ]

        _otel_config = OtelConfig(
            enabled=os.getenv("OTEL_ENABLED", "false").lower() == "true",
            service_name=default_service_name,
            otlp_endpoint=os.getenv(
                "OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4317"
            ),
            sampler_ratio=float(os.getenv("OTEL_TRACES_SAMPLER_ARG", "1.0")),
            metrics_enabled=os.getenv("OTEL_METRICS_ENABLED", "false").lower()
            == "true",
            capture_request_headers=os.getenv(
                "OTEL_CAPTURE_REQUEST_HEADERS", "false"
            ).lower()
            == "true",
            capture_request_body=os.getenv("OTEL_CAPTURE_REQUEST_BODY", "false").lower()
            == "true",
            capture_response_headers=os.getenv(
                "OTEL_CAPTURE_RESPONSE_HEADERS", "false"
            ).lower()
            == "true",
            capture_response_body=os.getenv(
                "OTEL_CAPTURE_RESPONSE_BODY", "false"
            ).lower()
            == "true",
            max_body_size=min(
                int(os.getenv("OTEL_MAX_BODY_SIZE", "4096")),
                10485760,  # Hard limit of 1MB to prevent memory issues
            ),
            excluded_urls=excluded_urls,
            included_urls=included_urls,
            # Default to True to reduce noise from SSE/streaming endpoints
            # This is the industry standard approach - see OpenTelemetry ASGI instrumentation docs
            disable_send_receive_spans=os.getenv(
                "OTEL_DISABLE_SEND_RECEIVE_SPANS", "true"
            ).lower()
            == "true",
        )

    return _otel_config


def get_otel_config_from_env() -> Dict[str, any]:
    """
    Get OpenTelemetry configuration from environment variables as a dictionary.

    This is a legacy function for backward compatibility. New code should
    use get_otel_config() which returns a typed OtelConfig dataclass.

    Returns:
        dict: Configuration dictionary with keys:
            - enabled: bool
            - service_name: str
            - otlp_endpoint: str
            - sampler_ratio: float
            - metrics_enabled: bool
    """
    config = get_otel_config()
    return {
        "enabled": config.enabled,
        "service_name": config.service_name,
        "otlp_endpoint": config.otlp_endpoint,
        "sampler_ratio": config.sampler_ratio,
        "metrics_enabled": config.metrics_enabled,
    }


# Global HTTP capture settings
_http_capture_settings: Dict[str, any] = {
    "capture_request_headers": False,
    "capture_request_body": False,
    "capture_response_headers": False,
    "capture_response_body": False,
    "max_body_size": 4096,
}


def get_http_capture_settings() -> Dict[str, any]:
    """
    Get the current HTTP capture settings.

    Returns:
        dict: HTTP capture settings dictionary
    """
    return _http_capture_settings.copy()


def set_http_capture_settings(
    capture_request_headers: bool = False,
    capture_request_body: bool = False,
    capture_response_headers: bool = False,
    capture_response_body: bool = False,
    max_body_size: int = 4096,
) -> None:
    """
    Set HTTP capture settings globally.

    Args:
        capture_request_headers: Whether to capture HTTP request headers
        capture_request_body: Whether to capture HTTP request body
        capture_response_headers: Whether to capture HTTP response headers
        capture_response_body: Whether to capture HTTP response body
        max_body_size: Maximum body size to capture in bytes (default: 4096)
    """
    global _http_capture_settings
    _http_capture_settings["capture_request_headers"] = capture_request_headers
    _http_capture_settings["capture_request_body"] = capture_request_body
    _http_capture_settings["capture_response_headers"] = capture_response_headers
    _http_capture_settings["capture_response_body"] = capture_response_body
    _http_capture_settings["max_body_size"] = max_body_size


def reset_otel_config() -> None:
    """
    Reset the cached OTEL configuration.

    This is primarily useful for testing purposes where you need to
    reload configuration with different environment variables.
    """
    global _otel_config
    _otel_config = None


def should_trace_url(url: str, config: Optional[OtelConfig] = None) -> bool:
    """
    Check if a URL should be traced based on include/exclude patterns.

    The logic is:
    1. If included_urls is set (whitelist mode), only trace URLs matching those patterns
    2. Otherwise, trace all URLs except those matching excluded_urls (blacklist mode)

    Patterns support:
    - Exact match: "/api/health"
    - Prefix match with wildcard: "/api/*" matches "/api/users", "/api/tasks", etc.
    - Regex patterns: "^/api/v[0-9]+/.*" (must start with ^)

    Args:
        url: The URL path to check (e.g., "/api/users/123")
        config: Optional OtelConfig instance. If not provided, uses get_otel_config()

    Returns:
        bool: True if the URL should be traced, False if it should be excluded

    Example:
        >>> should_trace_url("/api/users")  # True (not in default excluded list)
        >>> should_trace_url("/health")     # False (in default excluded list)
        >>> should_trace_url("/api/docs")   # False (in default excluded list)
    """
    if config is None:
        config = get_otel_config()

    # Whitelist mode: if included_urls is set, only trace matching URLs
    if config.included_urls:
        return _url_matches_patterns(url, config.included_urls)

    # Blacklist mode: trace all URLs except those in excluded_urls
    if config.excluded_urls:
        return not _url_matches_patterns(url, config.excluded_urls)

    # No filters configured, trace everything
    return True


def _url_matches_patterns(url: str, patterns: List[str]) -> bool:
    """
    Check if a URL matches any of the given patterns.

    Args:
        url: The URL path to check
        patterns: List of patterns to match against

    Returns:
        bool: True if URL matches any pattern
    """
    for pattern in patterns:
        if _url_matches_pattern(url, pattern):
            return True
    return False


def _url_matches_pattern(url: str, pattern: str) -> bool:
    """
    Check if a URL matches a single pattern.

    Supports:
    - Exact match: "/api/health"
    - Prefix match with wildcard: "/api/*" matches "/api/users"
    - Regex patterns: "^/api/v[0-9]+/.*" (must start with ^)

    Args:
        url: The URL path to check
        pattern: The pattern to match against

    Returns:
        bool: True if URL matches the pattern
    """
    # Regex pattern (starts with ^)
    if pattern.startswith("^"):
        try:
            return bool(re.match(pattern, url))
        except re.error:
            return False

    # Wildcard pattern (ends with *)
    if pattern.endswith("*"):
        prefix = pattern[:-1]
        return url.startswith(prefix)

    # Exact match
    return url == pattern


def get_excluded_urls_regex() -> str:
    """
    Get excluded URLs as a regex pattern string for FastAPI instrumentation.

    This is useful for passing to FastAPIInstrumentor's excluded_urls parameter.

    Returns:
        str: Regex pattern string that matches all excluded URLs

    Example:
        >>> get_excluded_urls_regex()
        '/health|/healthz|/ready|/metrics|/api/docs|/api/openapi.json|/favicon.ico'
    """
    config = get_otel_config()
    if not config.excluded_urls:
        return ""

    # Convert patterns to regex
    regex_parts = []
    for pattern in config.excluded_urls:
        if pattern.startswith("^"):
            # Already a regex, use as-is (remove the ^ as we'll join with |)
            regex_parts.append(pattern[1:] if pattern.startswith("^") else pattern)
        elif pattern.endswith("*"):
            # Wildcard pattern: /api/* -> /api/.*
            prefix = re.escape(pattern[:-1])
            regex_parts.append(f"{prefix}.*")
        else:
            # Exact match: escape special chars and add anchors
            regex_parts.append(f"^{re.escape(pattern)}$")

    return "|".join(regex_parts)
