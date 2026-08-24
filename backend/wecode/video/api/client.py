# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP and response-shape adapter for the external AIGC video service."""

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.core.config import settings

IN_PROGRESS_STATUSES = {
    "created",
    "pending",
    "processing",
    "queued",
    "running",
    "submitted",
}
COMPLETED_STATUSES = {"completed", "success", "succeeded"}
FAILED_STATUSES = {"cancelled", "error", "failed", "failure"}


@dataclass(frozen=True)
class AigcCardStatus:
    status: str
    progress: int
    progress_text: str
    card: dict[str, Any]
    error: str

    @property
    def is_partial_ready(self) -> bool:
        return self.status == "partial_ready"

    @property
    def is_in_progress(self) -> bool:
        return self.status in IN_PROGRESS_STATUSES

    @property
    def is_completed(self) -> bool:
        return self.status in COMPLETED_STATUSES

    @property
    def is_failed(self) -> bool:
        return self.status in FAILED_STATUSES


def validate_task_url(task_url: str) -> str:
    """Allow polling only below the configured AIGC service base URL."""
    configured = urlsplit(settings.AIGC_VIDEO_AGENT_URL.rstrip("/"))
    candidate = urlsplit(task_url)
    if candidate.scheme not in {"http", "https"} or candidate.username:
        raise ValueError("Invalid AIGC task URL")
    if (candidate.scheme, candidate.hostname, candidate.port) != (
        configured.scheme,
        configured.hostname,
        configured.port,
    ):
        raise ValueError("AIGC task URL does not match the configured service")

    base_path = configured.path.rstrip("/")
    expected_path = f"{base_path}/aigc_video/"
    if not candidate.path.startswith(expected_path):
        raise ValueError("AIGC task URL is outside the configured API path")
    return task_url


def validate_playback_url(video_url: str) -> str:
    """Allow browser playback redirects only for Weibo video CDN URLs."""
    candidate = urlsplit(video_url)
    hostname = (candidate.hostname or "").lower()
    if (
        candidate.scheme not in {"http", "https"}
        or candidate.username
        or candidate.password
        or hostname != "weibocdn.com"
        and not hostname.endswith(".weibocdn.com")
    ):
        raise ValueError("Invalid AIGC playback URL")
    return video_url


def validate_image_url(image_url: str) -> str:
    """Allow image proxying only for the configured Weibo CDN families."""
    candidate = urlsplit(image_url)
    hostname = (candidate.hostname or "").lower()
    allowed = (
        hostname == "sinaimg.cn"
        or hostname.endswith(".sinaimg.cn")
        or hostname == "weibocdn.com"
        or hostname.endswith(".weibocdn.com")
    )
    if (
        candidate.scheme not in {"http", "https"}
        or candidate.username
        or candidate.password
        or not allowed
    ):
        raise ValueError("Invalid AIGC image URL")
    return image_url


def _progress_value(value: Any) -> int:
    if isinstance(value, dict):
        value = value.get("percentage", value.get("progress", 0))
    try:
        return max(0, min(100, int(float(value or 0))))
    except (TypeError, ValueError):
        return 0


def _card_data(raw: dict[str, Any], wb_data: dict[str, Any]) -> dict[str, Any]:
    card = wb_data.get("card")
    data = dict(card) if isinstance(card, dict) else {}
    if wb_data.get("progress_text"):
        data["progress_text"] = wb_data["progress_text"]

    result = raw.get("result") if isinstance(raw.get("result"), dict) else {}
    for key in ("video_url", "cover_url", "media_id", "duration"):
        value = wb_data.get(key, result.get(key))
        if value is not None:
            data[key] = value

    buttons: list[dict[str, Any]] = []
    for section in data.get("content", []):
        if not isinstance(section, dict) or section.get("type") != "button":
            continue
        values = section.get("value")
        if isinstance(values, list):
            for index, item in enumerate(values):
                if not isinstance(item, dict):
                    continue
                # Prompts and skill names are execution details. Keep them on
                # the AIGC side and expose only the fields needed to render an
                # action. Clicking a chat button sends its public label back to
                # the agent, which then selects the next workflow tool.
                public_button: dict[str, Any] = {
                    "button_id": str(item.get("button_id") or f"button-{index}"),
                    "button_name": str(item.get("button_name") or ""),
                    "button_type": str(item.get("button_type") or "chat"),
                }
                credit_params = item.get("credit_params")
                if isinstance(credit_params, dict):
                    public_button["credit_params"] = dict(credit_params)
                buttons.append(public_button)
    if buttons:
        data["buttons"] = buttons
    return data


def parse_card_status(raw: dict[str, Any]) -> AigcCardStatus:
    wb_data = raw.get("wb_data") if isinstance(raw.get("wb_data"), dict) else raw
    status = str(wb_data.get("status") or raw.get("status") or "pending").lower()
    error = str(
        wb_data.get("error_message") or raw.get("error") or raw.get("detail") or ""
    ).strip()
    return AigcCardStatus(
        status=status,
        progress=_progress_value(wb_data.get("progress", raw.get("progress"))),
        progress_text=str(wb_data.get("progress_text") or "").strip(),
        card=_card_data(raw, wb_data),
        error=error,
    )


def fetch_card_status(task_url: str) -> AigcCardStatus:
    validate_task_url(task_url)
    with httpx.Client(timeout=20.0, trust_env=False) as client:
        response = client.get(task_url)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("AIGC status response must be a JSON object")
    return parse_card_status(payload)


def fetch_health() -> dict[str, Any]:
    url = f"{settings.AIGC_VIDEO_AGENT_URL.rstrip('/')}/aigc_video/health/"
    with httpx.Client(timeout=10.0, trust_env=False) as client:
        response = client.get(url)
        response.raise_for_status()
        payload = response.json()
    return payload if isinstance(payload, dict) else {"status": "unknown"}
