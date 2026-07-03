# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for understanding media through a fixed multimodal model."""

import asyncio
import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from app.core.config import settings
from app.mcp_server.auth import TaskTokenInfo
from app.models.kind import Kind
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.chat.config.model_resolver import extract_and_process_model_config
from app.services.context.context_service import (
    VideoAttachmentResolutionError,
    context_service,
)
from app.stores.tasks import subtask_store, task_access_store
from shared.models.execution import ExecutionRequest

logger = logging.getLogger(__name__)

MEDIA_TYPE_VIDEO = "video"
MEDIA_TYPE_IMAGE = "image"
DEFAULT_MAX_TOKENS = 4096
DEFAULT_TIMEOUT_SECONDS = 180.0


class MediaUnderstandingError(ValueError):
    """Structured error that should be returned to tool callers."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ResolvedMedia:
    media_type: str
    source: str
    context_id: Optional[int] = None
    media_url: str = ""
    image_base64: str = ""
    mime_type: str = ""


@dataclass(frozen=True)
class PreparedMediaUnderstandingRequest:
    resolved: ResolvedMedia
    model_config: dict[str, Any]
    question: str
    instruction: str
    context: dict[str, Any]


class MediaUnderstandingClient:
    """Client for the fixed multimodal model."""

    @staticmethod
    def _validate_config(model_config: dict[str, Any]) -> None:
        if not model_config:
            raise MediaUnderstandingError(
                "configuration_error",
                "Media understanding model is not configured",
            )

        required_fields = ("model", "model_id", "api_key", "base_url")
        missing = [field for field in required_fields if not model_config.get(field)]
        if missing:
            raise MediaUnderstandingError(
                "configuration_error",
                f"Media understanding model config missing fields: {', '.join(missing)}",
            )

        provider = str(model_config.get("model") or "").lower()
        if provider not in {"anthropic", "claude"}:
            raise MediaUnderstandingError(
                "configuration_error",
                "Only Anthropic-compatible media URL models are supported",
            )

    async def understand_media(
        self,
        *,
        model_config: dict[str, Any],
        media_type: str,
        media_url: str,
        image_base64: str,
        mime_type: str,
        question: str,
        instruction: str,
        context: dict[str, Any],
    ) -> str:
        """Call the fixed multimodal model and return its text answer."""
        self._validate_config(model_config)

        timeout = float(
            model_config.get("timeout")
            or model_config.get("timeout_seconds")
            or DEFAULT_TIMEOUT_SECONDS
        )
        headers = self._build_headers(model_config)
        payload = self._build_payload(
            model_config=model_config,
            media_type=media_type,
            media_url=media_url,
            image_base64=image_base64,
            mime_type=mime_type,
            question=question,
            instruction=instruction,
            context=context,
        )
        base_url = str(model_config["base_url"]).rstrip("/")

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{base_url}/v1/messages",
                json=payload,
                headers=headers,
            )
            if response.status_code >= 400:
                raise MediaUnderstandingError(
                    "model_error",
                    f"Media understanding model request failed: {response.status_code}",
                )
            data = response.json()

        text = self._extract_text(data)
        return text.strip()

    def _build_headers(self, model_config: dict[str, Any]) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": str(model_config.get("api_key") or ""),
        }
        default_headers = model_config.get("default_headers") or {}
        if isinstance(default_headers, dict):
            headers.update({str(k): str(v) for k, v in default_headers.items()})
        return headers

    def _build_payload(
        self,
        *,
        model_config: dict[str, Any],
        media_type: str,
        media_url: str,
        image_base64: str,
        mime_type: str,
        question: str,
        instruction: str,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        max_tokens = _resolve_max_tokens(model_config)
        media_block = _build_media_block(
            media_type=media_type,
            media_url=media_url,
            image_base64=image_base64,
            mime_type=mime_type,
        )
        return {
            "model": model_config["model_id"],
            "max_tokens": max_tokens,
            "system": _build_system_prompt(),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        media_block,
                        {
                            "type": "text",
                            "text": _build_user_prompt(
                                question=question,
                                instruction=instruction,
                                context=context,
                            ),
                        },
                    ],
                }
            ],
        }

    @staticmethod
    def _extract_text(data: dict[str, Any]) -> str:
        content = data.get("content")
        if not isinstance(content, list):
            raise MediaUnderstandingError(
                "model_error", "Media understanding model returned no content"
            )

        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)

        text = "\n".join(parts).strip()
        if not text:
            raise MediaUnderstandingError(
                "model_error", "Media understanding model returned empty text"
            )
        return text


class MediaUnderstandingService:
    """Resolve media input and call the fixed media understanding model."""

    def __init__(self, client: Optional[MediaUnderstandingClient] = None):
        self.client = client or MediaUnderstandingClient()

    def understand_media(
        self,
        db: Session,
        *,
        token_info: TaskTokenInfo,
        media_type: str = MEDIA_TYPE_VIDEO,
        context_id: Optional[int] = None,
        attachment_id: Optional[int] = None,
        media_url: Optional[str] = None,
        question: Optional[str] = None,
        instruction: Optional[str] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Understand media and return a minimal tool result."""
        started_at = time.monotonic()
        try:
            prepared = self.prepare_understand_media(
                db,
                token_info=token_info,
                media_type=media_type,
                context_id=context_id,
                attachment_id=attachment_id,
                media_url=media_url,
                question=question,
                instruction=instruction,
                context=context,
            )
            return self.understand_prepared_media(
                prepared,
                token_info=token_info,
                started_at=started_at,
            )
        except MediaUnderstandingError as exc:
            return self._handle_media_understanding_error(
                exc,
                token_info=token_info,
                started_at=started_at,
            )
        except Exception as exc:
            return self._handle_unexpected_error(
                exc,
                token_info=token_info,
                started_at=started_at,
            )

    def prepare_understand_media(
        self,
        db: Session,
        *,
        token_info: TaskTokenInfo,
        media_type: str = MEDIA_TYPE_VIDEO,
        context_id: Optional[int] = None,
        attachment_id: Optional[int] = None,
        media_url: Optional[str] = None,
        question: Optional[str] = None,
        instruction: Optional[str] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> PreparedMediaUnderstandingRequest:
        """Resolve DB-backed inputs before the long-running model call."""
        resolved = self._resolve_media(
            db,
            token_info=token_info,
            media_type=media_type,
            context_id=context_id,
            attachment_id=attachment_id,
            media_url=media_url,
        )
        model_config = self._resolve_model_config(db, token_info)
        return PreparedMediaUnderstandingRequest(
            resolved=resolved,
            model_config=model_config,
            question=(question or "").strip(),
            instruction=(instruction or "").strip(),
            context=_sanitize_context(context),
        )

    def understand_prepared_media(
        self,
        prepared: PreparedMediaUnderstandingRequest,
        *,
        token_info: TaskTokenInfo,
        started_at: Optional[float] = None,
    ) -> dict[str, Any]:
        """Call the model after all DB-backed inputs have been resolved."""
        started_at = started_at or time.monotonic()
        try:
            answer = _run_coroutine_sync(
                self.client.understand_media(
                    model_config=prepared.model_config,
                    media_type=prepared.resolved.media_type,
                    media_url=prepared.resolved.media_url,
                    image_base64=prepared.resolved.image_base64,
                    mime_type=prepared.resolved.mime_type,
                    question=prepared.question,
                    instruction=prepared.instruction,
                    context=prepared.context,
                )
            )
            result = {
                "status": "success",
                "answer": answer,
                "model": prepared.model_config.get("model_id", ""),
                "source": prepared.resolved.source,
            }
            logger.info(
                "[MediaUnderstanding] success task_id=%s subtask_id=%s source=%s context_id=%s elapsed=%.2fs",
                token_info.task_id,
                token_info.subtask_id,
                prepared.resolved.source,
                prepared.resolved.context_id,
                time.monotonic() - started_at,
            )
            return result
        except MediaUnderstandingError as exc:
            return self._handle_media_understanding_error(
                exc,
                token_info=token_info,
                started_at=started_at,
            )
        except Exception as exc:
            return self._handle_unexpected_error(
                exc,
                token_info=token_info,
                started_at=started_at,
            )

    def _handle_media_understanding_error(
        self,
        exc: MediaUnderstandingError,
        *,
        token_info: TaskTokenInfo,
        started_at: float,
    ) -> dict[str, Any]:
        logger.warning(
            "[MediaUnderstanding] failed task_id=%s subtask_id=%s code=%s elapsed=%.2fs",
            token_info.task_id,
            token_info.subtask_id,
            exc.code,
            time.monotonic() - started_at,
        )
        return _error_result(exc.code, exc.message)

    def _handle_unexpected_error(
        self,
        exc: Exception,
        *,
        token_info: TaskTokenInfo,
        started_at: float,
    ) -> dict[str, Any]:
        logger.exception(
            "[MediaUnderstanding] unexpected error task_id=%s subtask_id=%s elapsed=%.2fs",
            token_info.task_id,
            token_info.subtask_id,
            time.monotonic() - started_at,
        )
        return _error_result("internal_error", str(exc))

    def handle_exception(
        self,
        exc: Exception,
        *,
        token_info: TaskTokenInfo,
        started_at: float,
    ) -> dict[str, Any]:
        """Return a structured error response for callers that split DB and model work."""
        if isinstance(exc, MediaUnderstandingError):
            return self._handle_media_understanding_error(
                exc,
                token_info=token_info,
                started_at=started_at,
            )
        return self._handle_unexpected_error(
            exc,
            token_info=token_info,
            started_at=started_at,
        )

    def _resolve_model_config(
        self,
        db: Session,
        token_info: TaskTokenInfo,
    ) -> dict[str, Any]:
        model_kind_id = int(settings.MEDIA_UNDERSTANDING_MODEL_KIND_ID or 0)
        if model_kind_id <= 0:
            raise MediaUnderstandingError(
                "configuration_error",
                "MEDIA_UNDERSTANDING_MODEL_KIND_ID is not configured",
            )

        model = (
            db.query(Kind)
            .filter(
                Kind.id == model_kind_id,
                Kind.kind == "Model",
                Kind.user_id == 0,
                Kind.is_active == True,
            )
            .first()
        )
        if not model or not model.json:
            raise MediaUnderstandingError(
                "configuration_error",
                f"Media understanding model kind id {model_kind_id} was not found",
            )

        model_spec = model.json.get("spec") or {}
        task_data = ExecutionRequest(
            task_id=token_info.task_id,
            subtask_id=token_info.subtask_id,
            user={
                "id": token_info.user_id,
                "name": token_info.user_name,
                "user_name": token_info.user_name,
            },
        )
        model_config = extract_and_process_model_config(
            model_spec,
            user_id=token_info.user_id,
            user_name=token_info.user_name,
            task_data=task_data,
        )
        model_config["model_name"] = model.name
        model_config["model_namespace"] = model.namespace
        return model_config

    def _resolve_media(
        self,
        db: Session,
        *,
        token_info: TaskTokenInfo,
        media_type: str,
        context_id: Optional[int],
        attachment_id: Optional[int],
        media_url: Optional[str],
    ) -> ResolvedMedia:
        if media_type not in {MEDIA_TYPE_VIDEO, MEDIA_TYPE_IMAGE}:
            raise MediaUnderstandingError(
                "unsupported_media_type",
                "Only image and video media are currently supported",
            )

        sources = [
            value
            for value in (
                context_id,
                attachment_id,
                media_url.strip() if isinstance(media_url, str) else None,
            )
            if value
        ]
        if len(sources) != 1:
            raise MediaUnderstandingError(
                "invalid_argument",
                "Provide exactly one of context_id, attachment_id, or media_url",
            )

        if context_id or attachment_id:
            context = self._get_accessible_context(
                db,
                token_info=token_info,
                context_id=context_id or attachment_id or 0,
            )
            if media_type == MEDIA_TYPE_IMAGE:
                return self._resolve_image_context(context)

            if not context_service.is_video_context(context):
                raise MediaUnderstandingError(
                    "unsupported_media_type",
                    f"Context {context.id} is not a video attachment",
                )
            try:
                payload = context_service.build_video_content_from_attachment(
                    db, context
                )
            except VideoAttachmentResolutionError as exc:
                raise MediaUnderstandingError(
                    "video_url_unavailable", str(exc)
                ) from exc
            if not payload or not _is_http_url(payload.video_url):
                raise MediaUnderstandingError(
                    "video_url_unavailable",
                    f"Failed to resolve video URL for context {context.id}",
                )
            return ResolvedMedia(
                media_type=MEDIA_TYPE_VIDEO,
                media_url=payload.video_url,
                source="attachment",
                context_id=context.id,
            )

        normalized_url = media_url.strip() if isinstance(media_url, str) else ""
        if not _is_http_url(normalized_url):
            raise MediaUnderstandingError(
                "invalid_media_url", "media_url must be an HTTP(S) URL"
            )
        return ResolvedMedia(
            media_type=media_type,
            media_url=normalized_url,
            source="media_url",
        )

    def _resolve_image_context(self, context: SubtaskContext) -> ResolvedMedia:
        if not context_service.is_image_context(context):
            raise MediaUnderstandingError(
                "unsupported_media_type",
                f"Context {context.id} is not an image attachment",
            )
        if not context.image_base64:
            raise MediaUnderstandingError(
                "image_payload_unavailable",
                f"Context {context.id} does not have image payload",
            )
        return ResolvedMedia(
            media_type=MEDIA_TYPE_IMAGE,
            source="attachment",
            context_id=context.id,
            image_base64=context.image_base64,
            mime_type=context.mime_type or "image/jpeg",
        )

    def _get_accessible_context(
        self,
        db: Session,
        *,
        token_info: TaskTokenInfo,
        context_id: int,
    ) -> SubtaskContext:
        context = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.id == context_id,
                SubtaskContext.context_type == ContextType.ATTACHMENT.value,
                SubtaskContext.status == ContextStatus.READY.value,
            )
            .first()
        )
        if not context:
            raise MediaUnderstandingError(
                "context_not_found", f"Context {context_id} was not found"
            )
        if context.user_id == token_info.user_id:
            return context
        if context.subtask_id > 0:
            subtask = subtask_store.get_by_id(db, subtask_id=context.subtask_id)
            if subtask and task_access_store.is_member(
                db,
                task_id=subtask.task_id,
                user_id=token_info.user_id,
            ):
                return context
        raise MediaUnderstandingError(
            "context_not_found", f"Context {context_id} was not found"
        )


def _build_system_prompt() -> str:
    return (
        "You are a media understanding service. Follow the user's question and "
        "analysis instruction as the primary task. Use any media modalities that "
        "the configured model can understand. If background context is provided, "
        "use it only when relevant and do not present unsupported guesses as facts. "
    )


def _build_user_prompt(
    *, question: str, instruction: str, context: dict[str, Any]
) -> str:
    sections: list[str] = []
    if question:
        sections.append(f"User question:\n{question}")
    if instruction:
        sections.append(f"Analysis instruction:\n{instruction}")
    if context:
        sections.append(
            "Background context:\n"
            + json.dumps(context, ensure_ascii=False, default=str)
        )
    sections.append("Return a concise natural-language answer.")
    return "\n\n".join(sections)


def _build_media_block(
    *,
    media_type: str,
    media_url: str,
    image_base64: str,
    mime_type: str,
) -> dict[str, Any]:
    if media_type == MEDIA_TYPE_VIDEO:
        return {
            "type": "video",
            "source": {"type": "url", "url": media_url},
        }
    if media_type == MEDIA_TYPE_IMAGE:
        if image_base64:
            return {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime_type or "image/jpeg",
                    "data": image_base64,
                },
            }
        return {
            "type": "image",
            "source": {"type": "url", "url": media_url},
        }
    raise MediaUnderstandingError(
        "unsupported_media_type",
        "Only image and video media are currently supported",
    )


def _sanitize_context(context: Optional[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(context, dict):
        return {}

    allowed_keys = {
        "title",
        "description",
        "source_url",
        "transcript",
        "metadata",
        "related_texts",
    }
    return {key: value for key, value in context.items() if key in allowed_keys}


def _resolve_max_tokens(model_config: dict[str, Any]) -> int:
    configured = model_config.get("max_tokens") or model_config.get("max_output_tokens")
    return int(configured or DEFAULT_MAX_TOKENS)


def _error_result(code: str, message: str) -> dict[str, Any]:
    return {
        "status": "error",
        "answer": "",
        "model": "",
        "source": "",
        "error_code": code,
        "error_message": message,
    }


def _is_http_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _run_coroutine_sync(coro: Any) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: dict[str, Any] = {}
    error: dict[str, BaseException] = {}

    def run_in_thread() -> None:
        try:
            result["value"] = asyncio.run(coro)
        except BaseException as exc:
            error["value"] = exc

    thread = threading.Thread(target=run_in_thread)
    thread.start()
    thread.join()

    if error:
        raise error["value"]
    return result.get("value")


media_understanding_service = MediaUnderstandingService()
