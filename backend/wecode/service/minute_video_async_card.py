# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Allow durable polling only for the configured private QIA origin."""

from __future__ import annotations

import os
from urllib.parse import urlparse

from app.services.execution.agents.video.async_card import (
    register_async_card_url_validator,
)

DEFAULT_QIA_BASE_URL = "http://i.multimedia.api.weibo.com"
QIA_WORKFLOW_PATH_PREFIX = "/aigc_video/"


def is_configured_qia_query_url(value: str) -> bool:
    """Return whether a polling URL belongs to the configured QIA workflow."""
    configured = os.getenv("AIGC_VIDEO_AGENT_URL", DEFAULT_QIA_BASE_URL).rstrip("/")
    target = urlparse(value)
    base = urlparse(configured)
    try:
        target_port = target.port
        base_port = base.port
    except ValueError:
        return False
    if (
        base.scheme not in {"http", "https"}
        or not base.hostname
        or target.username
        or target.password
    ):
        return False
    return (
        target.scheme == base.scheme
        and target.hostname == base.hostname
        and target_port == base_port
        and target.path.startswith(QIA_WORKFLOW_PATH_PREFIX)
    )


register_async_card_url_validator(is_configured_qia_query_url)
