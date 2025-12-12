# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry metrics module for Wegent services.

Provides pre-defined business metrics and decorators for automatic metric collection.
"""

# Business metrics
from shared.telemetry.metrics.business import (
    WegentMetrics,
    get_wegent_metrics,
    record_message_sent,
    record_model_call,
    record_session_active_change,
    record_session_opened,
    record_task_completed,
    record_task_created,
    record_task_failed,
    record_user_activity,
)

# Metric tracking decorators
from shared.telemetry.metrics.decorators import track_duration, track_metric

__all__ = [
    # Business metrics
    "WegentMetrics",
    "get_wegent_metrics",
    "record_session_opened",
    "record_session_active_change",
    "record_message_sent",
    "record_task_created",
    "record_task_completed",
    "record_task_failed",
    "record_user_activity",
    "record_model_call",
    # Decorators
    "track_metric",
    "track_duration",
]
