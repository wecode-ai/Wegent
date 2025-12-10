#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
OpenTelemetry instrumentation setup for all services.

DEPRECATED: This module is kept for backward compatibility.
Please use `shared.telemetry.instrumentation` instead:

    from shared.telemetry.instrumentation import setup_opentelemetry_instrumentation
"""

# Re-export from new module structure for backward compatibility
from shared.telemetry.instrumentation import setup_opentelemetry_instrumentation

__all__ = ["setup_opentelemetry_instrumentation"]