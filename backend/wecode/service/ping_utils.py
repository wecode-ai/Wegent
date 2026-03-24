# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Ping utility functions for device network reachability detection.

This module provides utilities for pinging device IPs and determining
their network reachability status.
"""

from typing import Optional

import aioping


class PingResult:
    """Represents the result of a ping operation."""

    def __init__(self, status: str, latency_ms: Optional[float] = None):
        self.status = status  # "no_ip", "unreachable", "ok"
        self.latency_ms = latency_ms

    @property
    def is_reachable(self) -> bool:
        return self.status == "ok"


async def ping_device_ip(ip: str, timeout: float = 2.0) -> PingResult:
    """
    Ping a device IP and return latency result.

    Args:
        ip: IP address to ping
        timeout: Timeout in seconds (default: 2.0)

    Returns:
        PingResult with status ("no_ip", "unreachable", "ok") and latency_ms
        - status="no_ip": IP is empty or "-"
        - status="unreachable": Ping failed or timed out
        - status="ok": Ping succeeded, latency_ms contains round-trip time
    """
    if not ip or ip == "-":
        return PingResult(status="no_ip")
    try:
        delay = await aioping.ping(ip, timeout=timeout)
        return PingResult(status="ok", latency_ms=delay * 1000)
    except Exception:
        return PingResult(status="unreachable")
