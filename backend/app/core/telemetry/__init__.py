# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry integration module for the backend service.

This module provides telemetry initialization and instrumentation setup
for FastAPI, SQLAlchemy, HTTPX, Requests, and system metrics.
"""

from app.core.telemetry.instrumentation import setup_opentelemetry_instrumentation

__all__ = ["setup_opentelemetry_instrumentation"]
