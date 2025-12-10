#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
OpenTelemetry core initialization module.

DEPRECATED: This module is kept for backward compatibility.
Please use `shared.telemetry` package instead:

    from shared.telemetry import init_telemetry, shutdown_telemetry, is_telemetry_enabled
    from shared.telemetry import get_tracer, get_meter
    from shared.telemetry.config import get_otel_config_from_env, get_http_capture_settings
"""

# Re-export from new module structure for backward compatibility
from shared.telemetry.core import (
    init_telemetry,
    shutdown_telemetry,
    is_telemetry_enabled,
    get_tracer,
    get_meter,
)

from shared.telemetry.config import (
    get_otel_config_from_env,
    get_http_capture_settings,
)

__all__ = [
    "init_telemetry",
    "shutdown_telemetry",
    "is_telemetry_enabled",
    "get_tracer",
    "get_meter",
    "get_otel_config_from_env",
    "get_http_capture_settings",
]
