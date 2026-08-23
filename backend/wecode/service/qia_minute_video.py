# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal QIA one-minute creative-video workflow adapter."""

from typing import Any
from urllib.parse import urlparse

import httpx

from app.services.execution.agents.video.workflows import (
    register_video_workflow_client,
)
from app.services.execution.agents.video.workflows.base import (
    VideoWorkflowCreation,
    VideoWorkflowSnapshot,
)
from wecode.config.qia_minute_video_config import qia_minute_video_settings

QIA_MINUTE_VIDEO_WORKFLOW = "qia_minute_video"
_IN_PROGRESS_STATUSES = {"pending", "processing", "running"}
_COMPLETED_STATUSES = {"completed", "complete", "success", "succeeded", "done"}
_FAILED_STATUSES = {"failed", "error", "cancelled"}


class QiaWorkflowError(RuntimeError):
    """QIA workflow request or protocol error."""


def is_http_url(value: Any) -> bool:
    """Return whether value is an absolute HTTP(S) URL."""
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _public_url(value: Any) -> str | None:
    return value if is_http_url(value) else None


def _public_card(raw: Any) -> dict[str, Any]:
    """Keep only public, data-only card fields returned by QIA."""
    if not isinstance(raw, dict):
        return {}

    card: dict[str, Any] = {}
    for key in ("title", "created_time", "preview_type"):
        value = raw.get(key)
        if isinstance(value, str):
            card[key] = value

    preview_content = raw.get("preview_content")
    if isinstance(preview_content, dict):
        text = preview_content.get("text")
        if isinstance(text, str):
            card["preview_content"] = {"text": text}

    for key in ("link", "video_url", "cover_url"):
        value = _public_url(raw.get(key))
        if value:
            card[key] = value

    buttons: list[dict[str, Any]] = []
    for raw_button in raw.get("buttons") or []:
        if not isinstance(raw_button, dict):
            continue
        button: dict[str, Any] = {}
        for key in ("button_id", "button_name", "button_type"):
            value = raw_button.get(key)
            if isinstance(value, str):
                button[key] = value
        target = _public_url(raw_button.get("url") or raw_button.get("link"))
        if target:
            button["url"] = target
        if button:
            buttons.append(button)
    card["buttons"] = buttons
    return card


def normalize_qia_payload(raw: dict[str, Any]) -> VideoWorkflowSnapshot:
    """Normalize the internal QIA response envelope."""
    data = raw.get("wb_data") if isinstance(raw.get("wb_data"), dict) else raw
    raw_status = str(data.get("status") or "processing").lower()
    card = _public_card(data.get("card"))
    if raw_status in _COMPLETED_STATUSES:
        status = "completed"
    elif raw_status in _FAILED_STATUSES:
        status = "failed"
    elif raw_status == "partial_ready" or (
        raw_status in _IN_PROGRESS_STATUSES and card.get("link")
    ):
        status = "partial_ready"
    elif raw_status in _IN_PROGRESS_STATUSES:
        status = raw_status
    else:
        status = "failed"

    raw_progress = data.get("progress")
    progress = int(raw_progress) if isinstance(raw_progress, (int, float)) else 0
    progress = min(100, max(0, progress))
    for key in ("video_url", "cover_url"):
        value = _public_url(data.get(key))
        if value and key not in card:
            card[key] = value

    error = data.get("error_message") or raw.get("error")
    if status == "failed" and not error:
        error = f"QIA workflow failed with status '{raw_status}'"
    return VideoWorkflowSnapshot(
        status=status,
        progress=progress,
        progress_text=str(data.get("progress_text") or ""),
        card=card,
        error=str(error) if error else None,
    )


class QiaMinuteVideoClient:
    """HTTP client for QIA's independent one-minute video workflow."""

    def __init__(
        self,
        create_url: str | None = None,
        api_token: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        settings = qia_minute_video_settings
        self.create_url = create_url or settings.QIA_MINUTE_VIDEO_CREATE_URL
        self.api_token = settings.QIA_API_TOKEN if api_token is None else api_token
        self.timeout_seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else settings.QIA_REQUEST_TIMEOUT_SECONDS
        )

    def _headers(self) -> dict[str, str]:
        if not self.api_token:
            return {}
        return {"Authorization": f"Bearer {self.api_token}"}

    async def create(
        self,
        *,
        prompt: str,
        model: str,
        model_display_name: str | None,
        reference_images: list[str | int],
        reference_videos: list[str | int],
        task_id: int,
        subtask_id: int,
        user_id: int,
    ) -> VideoWorkflowCreation:
        if not is_http_url(self.create_url):
            raise QiaWorkflowError("QIA minute-video endpoint is not configured")

        body = {
            "prompt": prompt,
            "model": model,
            "model_display_name": model_display_name,
            "reference_images": reference_images,
            "reference_videos": reference_videos,
            "wegent_task_id": task_id,
            "wegent_subtask_id": subtask_id,
            "wegent_user_id": user_id,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    self.create_url,
                    json={
                        key: value for key, value in body.items() if value is not None
                    },
                    headers=self._headers(),
                )
                response.raise_for_status()
                raw = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise QiaWorkflowError("QIA minute-video request failed") from exc
        if not isinstance(raw, dict):
            raise QiaWorkflowError("QIA returned an invalid response")

        query_url = raw.get("task_url") or raw.get("query_url")
        if not is_http_url(query_url):
            raise QiaWorkflowError("QIA did not return a valid task URL")
        external_task_id = raw.get("task_id")
        return VideoWorkflowCreation(
            query_url=query_url,
            snapshot=normalize_qia_payload(raw),
            external_task_id=(
                str(external_task_id) if external_task_id is not None else None
            ),
        )

    async def get_status(self, query_url: str) -> VideoWorkflowSnapshot:
        if not is_http_url(query_url):
            raise QiaWorkflowError("QIA task URL is invalid")
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.get(query_url, headers=self._headers())
                response.raise_for_status()
                raw = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise QiaWorkflowError("QIA minute-video status request failed") from exc
        if not isinstance(raw, dict):
            raise QiaWorkflowError("QIA returned an invalid status response")
        return normalize_qia_payload(raw)


register_video_workflow_client(QIA_MINUTE_VIDEO_WORKFLOW, QiaMinuteVideoClient)
