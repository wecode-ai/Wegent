# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Breeze-style process metrics shared by Wegent services.

Mirrors the ``brz-metrics`` contract used by the Wegent Rust gateway: services
record into one process-wide registry, and a background thread drains the
registry every interval into ProfileUtil JSON lines appended to a profile log.
Because the Python services emit the same line format as the Rust gateway, the
existing collection pipeline picks the series up without any new scrape target.

Configuration is injected by the deployment through environment variables:

- ``WECODE_METRICS_PROFILE_LOG_PATH``: profile log destination. Falls back to
  the directory of ``WEGENT_LOG_FILE_PATH``, then to ``$LOG_DIR/profile.log``,
  then to ``logs/profile.log``. The Rust gateway keeps its own
  ``BREEZE_PROFILE_LOG_PATH``, so the two writers never share a file.
- ``WECODE_METRICS_PROFILE_INTERVAL_SECONDS``: drain interval, default 30.
- ``WECODE_METRICS_ENABLED``: set to ``false`` to disable the profile logger.
"""

from shared.metrics.api import ApiRouteMetrics, track_api, track_api_sync
from shared.metrics.metric import Metric, MetricSnapshot
from shared.metrics.profile import (
    profile_log_path,
    reset_profile_log_path,
    start_profile_logger,
    write_profile_once,
)
from shared.metrics.registry import get_registry

__all__ = [
    "ApiRouteMetrics",
    "Metric",
    "MetricSnapshot",
    "get_registry",
    "profile_log_path",
    "reset_profile_log_path",
    "start_profile_logger",
    "track_api",
    "track_api_sync",
    "write_profile_once",
]
