# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Durable asynchronous CardBlock polling for external video workflows."""

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import httpx

from app.mcp_server.auth import TaskTokenInfo
from app.services.url_metadata import _validate_url_for_ssrf

logger = logging.getLogger(__name__)

VIDEO_DIRECTOR_CARD_TYPE = "video_director_generation"
CARD_QUERY_TIMEOUT_SECONDS = 15

_IN_PROGRESS_STATUSES = {"pending", "processing"}
_PRIVATE_CARD_KEYS = {
    "polling_url",
    "prompt",
    "query_url",
    "skill",
    "task_url",
}
_PUBLIC_URL_KEYS = {
    "cover_url",
    "link",
    "url",
    "video_url",
}
_QUERY_URL_VALIDATORS: list[Callable[[str], bool]] = []
_CARD_DATA_NORMALIZERS: list[Callable[[dict[str, Any]], dict[str, Any]]] = []


class AsyncCardError(RuntimeError):
    """External card query or protocol error."""


@dataclass(frozen=True)
class AsyncCardSnapshot:
    """Normalized public state returned by an external card workflow."""

    status: str
    progress: int = 0
    progress_text: str = ""
    card: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @property
    def is_completed(self) -> bool:
        return self.status == "completed"

    @property
    def is_failed(self) -> bool:
        return self.status == "failed"

    @property
    def is_partial_ready(self) -> bool:
        return self.status == "partial_ready"


def is_http_url(value: Any) -> bool:
    """Return whether value is an absolute HTTP(S) URL."""
    if not isinstance(value, str):
        return False
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def register_async_card_url_validator(validator: Callable[[str], bool]) -> None:
    """Register a trusted internal URL policy for private workflow endpoints."""
    if validator not in _QUERY_URL_VALIDATORS:
        _QUERY_URL_VALIDATORS.append(validator)


def register_async_card_data_normalizer(
    normalizer: Callable[[dict[str, Any]], dict[str, Any]],
) -> None:
    """Register an internal adapter for external workflow card data."""
    if normalizer not in _CARD_DATA_NORMALIZERS:
        _CARD_DATA_NORMALIZERS.append(normalizer)


def validate_async_card_query_url(value: Any) -> str:
    """Validate an external polling URL against public and internal policies."""
    if not is_http_url(value):
        raise AsyncCardError("task_url must be an absolute HTTP(S) URL")
    query_url = str(value).strip()
    parsed = urlparse(query_url)
    if parsed.username or parsed.password:
        raise AsyncCardError("task_url must not contain URL credentials")

    for validator in tuple(_QUERY_URL_VALIDATORS):
        try:
            if validator(query_url):
                return query_url
        except Exception:
            logger.exception("Async card URL validator failed")

    if _validate_url_for_ssrf(query_url):
        return query_url
    raise AsyncCardError("task_url is not an allowed HTTP(S) endpoint")


def _sanitize_card_value(value: Any, key: str | None = None) -> Any:
    """Keep JSON-safe public card data while removing internal workflow fields."""
    if key in _PUBLIC_URL_KEYS:
        return value if is_http_url(value) else None
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            if not isinstance(raw_key, str):
                continue
            if raw_key.startswith("_") or raw_key in _PRIVATE_CARD_KEYS:
                continue
            sanitized = _sanitize_card_value(raw_value, raw_key)
            if sanitized is not None:
                result[raw_key] = sanitized
        return result
    if isinstance(value, list):
        return [
            sanitized
            for item in value
            if (sanitized := _sanitize_card_value(item)) is not None
        ]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def sanitize_card_data(raw: Any) -> dict[str, Any]:
    """Return public, data-only card content."""
    if not isinstance(raw, dict):
        return {}
    sanitized = _sanitize_card_value(raw)
    return sanitized if isinstance(sanitized, dict) else {}


def _normalize_card_data(raw: Any) -> dict[str, Any]:
    card = dict(raw) if isinstance(raw, dict) else {}
    for normalizer in tuple(_CARD_DATA_NORMALIZERS):
        try:
            normalized = normalizer(card)
        except Exception:
            logger.exception("Async card data normalizer failed")
            continue
        if isinstance(normalized, dict):
            card = normalized
    return card


def normalize_async_card_payload(raw: dict[str, Any]) -> AsyncCardSnapshot:
    """Normalize the generic ``wb_data`` card polling envelope."""
    data = raw.get("wb_data") if isinstance(raw.get("wb_data"), dict) else raw
    raw_status = str(data.get("status") or "").strip().lower()
    card = sanitize_card_data(_normalize_card_data(data.get("card")))

    for key in ("video_url", "cover_url"):
        value = data.get(key)
        if key not in card and is_http_url(value):
            card[key] = value

    if raw_status == "completed":
        status = "completed"
    elif raw_status == "failed":
        status = "failed"
    elif raw_status == "partial_ready":
        status = "partial_ready"
    elif raw_status in _IN_PROGRESS_STATUSES:
        status = raw_status
    else:
        status = "failed"

    raw_progress = data.get("progress")
    progress = int(raw_progress) if isinstance(raw_progress, (int, float)) else 0
    progress = min(100, max(0, progress))
    error = data.get("error_message") or data.get("error") or raw.get("error")
    if status == "failed" and not error:
        error = f"Card workflow failed with status '{raw_status}'"

    return AsyncCardSnapshot(
        status=status,
        progress=progress,
        progress_text=str(data.get("progress_text") or ""),
        card=card,
        error=str(error) if error else None,
    )


async def fetch_async_card_snapshot(query_url: str) -> AsyncCardSnapshot:
    """Fetch and normalize one external card workflow status response."""
    validated_url = validate_async_card_query_url(query_url)
    try:
        async with httpx.AsyncClient(
            timeout=CARD_QUERY_TIMEOUT_SECONDS,
            follow_redirects=False,
        ) as client:
            response = await client.get(validated_url)
            response.raise_for_status()
            raw = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise AsyncCardError("Card workflow status request failed") from exc
    if not isinstance(raw, dict):
        raise AsyncCardError("Card workflow returned an invalid response")
    return normalize_async_card_payload(raw)


def build_async_card_block(
    *,
    block_id: str,
    card_type: str,
    snapshot: AsyncCardSnapshot,
    preview_title: str,
    default_progress_text: str,
) -> dict[str, Any]:
    """Build the shared CardBlock representation for a workflow snapshot."""
    if snapshot.is_completed:
        block_status = "done"
        card_status = "populated"
    elif snapshot.is_failed:
        block_status = "error"
        card_status = "error"
    elif snapshot.is_partial_ready:
        block_status = "streaming"
        card_status = "partial_ready"
    else:
        block_status = "pending"
        card_status = "pending"

    card = dict(snapshot.card)
    return {
        "id": block_id,
        "type": "card",
        "status": block_status,
        "card_type": card_type,
        "card_id": block_id,
        "card_status": card_status,
        "card_data": card,
        "card_preview_data": {
            "title": card.get("title") or preview_title,
            "progress": snapshot.progress,
            "progress_text": snapshot.progress_text or default_progress_text,
            "video_url": card.get("video_url"),
            "cover_url": card.get("cover_url"),
        },
        "card_error": snapshot.error,
        "timestamp": int(time.time() * 1000),
    }


class AsyncVideoCardService:
    """Create pending CardBlocks and reuse the shared video task lifecycle."""

    async def create(
        self,
        *,
        token_info: TaskTokenInfo,
        task_url: str,
        card_type: str = VIDEO_DIRECTOR_CARD_TYPE,
        preview_title: str = "",
        progress_text: str = "",
    ) -> dict[str, Any]:
        try:
            query_url = validate_async_card_query_url(task_url)
        except AsyncCardError as exc:
            raise ValueError(str(exc)) from exc
        normalized_card_type = card_type.strip()
        if not normalized_card_type:
            raise ValueError("card_type is required")

        block_id = f"card-{uuid.uuid4().hex}"
        job_id = f"async-card-{uuid.uuid4().hex}"
        snapshot = AsyncCardSnapshot(
            status="pending",
            progress=0,
            progress_text=progress_text,
        )
        block = build_async_card_block(
            block_id=block_id,
            card_type=normalized_card_type,
            snapshot=snapshot,
            preview_title=preview_title,
            default_progress_text=progress_text,
        )
        now = datetime.now(timezone.utc).isoformat()
        video_job = {
            "job_id": job_id,
            "query_url": query_url,
            "card_type": normalized_card_type,
            "preview_title": preview_title,
            "progress_text": progress_text,
            "status": "polling",
            "progress": 0,
            "video_block_id": block_id,
            "started_at": now,
            "last_poll_at": now,
            "poll_count": 0,
        }

        from app.tasks.video_tasks import (
            dispatch_video_polling_task,
            fail_video_generation_start,
            update_subtask_video_job,
        )
        from app.tasks.video_websocket import emit_card_created

        try:
            await asyncio.to_thread(
                update_subtask_video_job,
                token_info.subtask_id,
                video_job,
                block,
            )
            emit_card_created(
                task_id=token_info.task_id,
                subtask_id=token_info.subtask_id,
                block=block,
            )
            dispatch_video_polling_task(
                subtask_id=token_info.subtask_id,
                task_id=token_info.task_id,
                user_id=token_info.user_id,
                job_id=job_id,
                provider_protocol="",
                video_block_id=block_id,
                model_config={},
                message_id=None,
                card_context={
                    "query_url": query_url,
                    "card_type": normalized_card_type,
                    "preview_title": preview_title,
                    "progress_text": progress_text,
                },
            )
        except Exception as exc:
            error = f"Failed to persist or dispatch async card: {exc}"
            failed_block = build_async_card_block(
                block_id=block_id,
                card_type=normalized_card_type,
                snapshot=AsyncCardSnapshot(
                    status="failed",
                    error=error,
                ),
                preview_title=preview_title,
                default_progress_text=progress_text,
            )
            failed_job = {
                **video_job,
                "status": "failed",
                "last_poll_at": datetime.now(timezone.utc).isoformat(),
            }
            try:
                await asyncio.to_thread(
                    update_subtask_video_job,
                    token_info.subtask_id,
                    failed_job,
                    failed_block,
                )
                from app.tasks.video_websocket import emit_card_error

                emit_card_error(
                    task_id=token_info.task_id,
                    subtask_id=token_info.subtask_id,
                    message_id=None,
                    block=failed_block,
                )
            except Exception:
                logger.exception(
                    "Failed to persist async card setup error for subtask %s",
                    token_info.subtask_id,
                )
            await asyncio.to_thread(
                fail_video_generation_start,
                token_info.subtask_id,
                error,
            )
            raise RuntimeError(error) from exc

        return {
            "id": block_id,
            "card_type": normalized_card_type,
            "status": block["card_status"],
            "data": block["card_data"],
            "preview_data": block["card_preview_data"],
        }


async_video_card_service = AsyncVideoCardService()
