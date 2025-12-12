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
"""

import os
from dataclasses import dataclass
from typing import Dict, Optional


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
        _otel_config = OtelConfig(
            enabled=os.getenv("OTEL_ENABLED", "false").lower() == "true",
            service_name=default_service_name,
            otlp_endpoint=os.getenv(
                "OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4317"
            ),
            sampler_ratio=float(os.getenv("OTEL_TRACES_SAMPLER_ARG", "1.0")),
            metrics_enabled=os.getenv("OTEL_METRICS_ENABLED", "false").lower() == "true",
            capture_request_headers=os.getenv(
                "OTEL_CAPTURE_REQUEST_HEADERS", "false"
            ).lower() == "true",
            capture_request_body=os.getenv(
                "OTEL_CAPTURE_REQUEST_BODY", "false"
            ).lower() == "true",
            capture_response_headers=os.getenv(
                "OTEL_CAPTURE_RESPONSE_HEADERS", "false"
            ).lower() == "true",
            capture_response_body=os.getenv(
                "OTEL_CAPTURE_RESPONSE_BODY", "false"
            ).lower() == "true",
            max_body_size=min(
                int(os.getenv("OTEL_MAX_BODY_SIZE", "4096")),
                10485760  # Hard limit of 1MB to prevent memory issues
            ),
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
