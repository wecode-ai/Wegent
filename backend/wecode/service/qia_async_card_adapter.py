# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Register private QIA polling and CardBlock normalization policies."""

from __future__ import annotations

from urllib.parse import urlparse

from app.core.config import settings
from app.services.execution.agents.video.async_card import (
    register_async_card_data_normalizer,
    register_async_card_url_validator,
)
from wecode.video.card_payload import normalize_qia_card_data
from wecode.video.config.media import video_media_settings

QIA_WORKFLOW_PATH_PREFIX = "/aigc_video/"


def is_configured_qia_query_url(value: str) -> bool:
    """Return whether a polling URL belongs to the configured QIA workflow."""
    configured = video_media_settings.AIGC_VIDEO_AGENT_URL.strip().rstrip("/")
    if not configured:
        return False

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
        or base.username
        or base.password
        or target.username
        or target.password
    ):
        return False

    workflow_path_prefix = f"{base.path.rstrip('/')}{QIA_WORKFLOW_PATH_PREFIX}"
    return (
        target.scheme == base.scheme
        and target.hostname == base.hostname
        and target_port == base_port
        and target.path.startswith(workflow_path_prefix)
    )


def normalize_configured_qia_card_data(
    card: dict[str, object],
) -> dict[str, object]:
    """Adapt QIA relative panel links and private button sections."""
    return normalize_qia_card_data(
        card,
        frontend_url=settings.FRONTEND_URL,
    )


register_async_card_url_validator(is_configured_qia_query_url)
register_async_card_data_normalizer(normalize_configured_qia_card_data)
