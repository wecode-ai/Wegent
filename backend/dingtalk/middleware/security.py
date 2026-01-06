# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk security middleware."""
import logging
import time
from collections import defaultdict
from typing import Dict, List

from fastapi import HTTPException, Request

from dingtalk.config import dingtalk_config

logger = logging.getLogger(__name__)

# Simple in-memory rate limiter (use Redis in production for multi-instance)
_rate_limit_store: Dict[str, List[float]] = defaultdict(list)


async def check_rate_limit(request: Request) -> None:
    """
    Rate limiting: max N requests per window per IP.
    """
    client_ip = request.client.host if request.client else "unknown"
    key = f"dingtalk_login:{client_ip}"
    now = time.time()
    window = dingtalk_config.rate_limit_window
    max_requests = dingtalk_config.rate_limit_requests

    # Clean old entries
    _rate_limit_store[key] = [
        ts for ts in _rate_limit_store[key] if now - ts < window
    ]

    # Check limit
    if len(_rate_limit_store[key]) >= max_requests:
        logger.warning(
            f"[DingTalk] Rate limit exceeded for IP {client_ip}: "
            f"{len(_rate_limit_store[key])} requests in {window}s"
        )
        raise HTTPException(
            status_code=429, detail="Too many requests. Please try again later."
        )

    # Record this request
    _rate_limit_store[key].append(now)


def check_referer(request: Request) -> None:
    """
    Validate Referer/Origin header.
    """
    allowed = dingtalk_config.allowed_referers
    if not allowed:
        return  # Skip if not configured

    referer = request.headers.get("referer", "")
    origin = request.headers.get("origin", "")

    if not any(referer.startswith(r) or origin.startswith(r) for r in allowed):
        logger.warning(
            f"[DingTalk] Invalid request origin: referer={referer}, origin={origin}, "
            f"allowed={allowed}"
        )
        raise HTTPException(status_code=403, detail="Invalid request origin")


def check_ip_whitelist(request: Request) -> None:
    """
    Optional IP whitelist check.
    """
    whitelist = dingtalk_config.ip_whitelist
    if not whitelist:
        return  # Skip if not configured

    client_ip = request.client.host if request.client else "unknown"
    if client_ip not in whitelist:
        logger.warning(
            f"[DingTalk] IP not in whitelist: {client_ip}, allowed={whitelist}"
        )
        raise HTTPException(status_code=403, detail="IP not allowed")
