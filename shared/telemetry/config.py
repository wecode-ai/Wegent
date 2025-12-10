# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry configuration module.

Provides configuration loading from environment variables and
global settings management for HTTP capture options.
"""

import os
from typing import Dict


def get_otel_config_from_env() -> Dict[str, any]:
    """
    Get OpenTelemetry configuration from environment variables.

    Returns:
        dict: Configuration dictionary with keys:
            - enabled: bool
            - service_name: str
            - otlp_endpoint: str
            - sampler_ratio: float
            - metrics_enabled: bool
    """
    return {
        "enabled": os.getenv("OTEL_ENABLED", "false").lower() == "true",
        "service_name": os.getenv("OTEL_SERVICE_NAME", "wegent-service"),
        "otlp_endpoint": os.getenv(
            "OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4317"
        ),
        "sampler_ratio": float(os.getenv("OTEL_TRACES_SAMPLER_ARG", "1.0")),
        "metrics_enabled": os.getenv("OTEL_METRICS_ENABLED", "false").lower() == "true",
    }


# Global HTTP capture settings
_http_capture_settings: Dict[str, bool] = {
    "capture_request_headers": False,
    "capture_request_body": False,
    "capture_response_headers": False,
    "capture_response_body": False,
}


def get_http_capture_settings() -> Dict[str, bool]:
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
) -> None:
    """
    Set HTTP capture settings globally.

    Args:
        capture_request_headers: Whether to capture HTTP request headers
        capture_request_body: Whether to capture HTTP request body
        capture_response_headers: Whether to capture HTTP response headers
        capture_response_body: Whether to capture HTTP response body
    """
    global _http_capture_settings
    _http_capture_settings["capture_request_headers"] = capture_request_headers
    _http_capture_settings["capture_request_body"] = capture_request_body
    _http_capture_settings["capture_response_headers"] = capture_response_headers
    _http_capture_settings["capture_response_body"] = capture_response_body
