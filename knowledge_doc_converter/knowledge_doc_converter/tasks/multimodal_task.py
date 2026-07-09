# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Multimodal analysis task: video/image → Gemini → Markdown → callback.

One Celery task serves BOTH media types:
- ``media_type="image"``: download via the attachment endpoint → if
  ≤ MULTIMODAL_INLINE_MAX_BYTES send inline base64 to Gemini, else stage via
  the pluggable MediaStagingProvider (NoOp default → fails fast with a clear
  message). Image inline analysis is fully functional in the open-source build.
- ``media_type="video"``: always requires staging (Gemini needs a model-readable
  URI for large media). The open-source default ships a NoOp staging provider,
  so video fails fast with ``video_staging_not_configured`` — the framework is
  fully wired, only the concrete staging implementation is a stub.

The two types diverge only in: fetch source, the inline-vs-staging delivery
decision, the prompt, and max_output_tokens. Everything else (model config
decryption, callback, retry/backoff, error classification, metrics, cleanup)
is shared.

Error handling:
- :class:`TransientError` → Celery retry with backoff; once retries are
  exhausted, fail fast so a transient storm doesn't leave the document stuck.
- :class:`PermanentError` → fail fast so we don't burn money retrying a bad
  key / safety block / unconfigured staging.

Billing: the Gemini api_key is resolved at execution time via the backend
internal model-config endpoint (P5: no api_key on the broker — the payload
carries only the KB's ``multimodalAnalysisModelRef`` + uploader identity).
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import time
from typing import Any, Dict, Optional

import httpx
from celery import Task
from celery.exceptions import Reject, SoftTimeLimitExceeded

from knowledge_doc_converter.celery_app import celery_app
from knowledge_doc_converter.config import settings
from knowledge_doc_converter.core.multimodal_metrics import (
    MULTIMODAL_ACTIVE,
    MULTIMODAL_CONVERSIONS_TOTAL,
    MULTIMODAL_DURATION_SECONDS,
    MULTIMODAL_GEMINI_BLOCKED_TOTAL,
    MULTIMODAL_GEMINI_ERRORS_TOTAL,
    MULTIMODAL_INPUT_BYTES,
    MULTIMODAL_OUTPUT_BYTES,
    MULTIMODAL_STAGE_DURATION_SECONDS,
    MULTIMODAL_STAGING_OPERATIONS_TOTAL,
)
from knowledge_doc_converter.services.callback_client import callback_client
from knowledge_doc_converter.services.content_fetcher import content_fetcher
from knowledge_doc_converter.services.errors import (
    PermanentError,
    TransientError,
)
from knowledge_doc_converter.services.gemini_analyzer import GeminiMultimodalAnalyzer
from knowledge_doc_converter.services.model_config_fetcher import (
    get_model_config_fetcher,
)
from knowledge_doc_converter.services.multimodal_coordinator import (
    get_staging_provider,
    multimodal_conversion_coordinator,
)
from shared.models.multimodal_prompts import (
    DEFAULT_IMAGE_PROMPT,
    DEFAULT_VIDEO_PROMPT,
)
from shared.telemetry.context.span import set_request_context
from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_sync,
)

logger = logging.getLogger(__name__)

_VIDEO_MIME_BY_EXT = {
    "mp4": "video/mp4",
    "avi": "video/x-msvideo",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska",
    "webm": "video/webm",
    "flv": "video/x-flv",
    "wmv": "video/x-ms-wmv",
    "m4v": "video/x-m4v",
}

_IMAGE_MIME_BY_EXT = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "webp": "image/webp",
}


@celery_app.task(
    bind=True,
    name="knowledge_doc_converter.convert_multimodal",
    queue=settings.MULTIMODAL_QUEUE,
    max_retries=settings.MULTIMODAL_RETRY_MAX,
    default_retry_delay=settings.MULTIMODAL_RETRY_COUNTDOWN_SECONDS,
    # Decorator limits are task-level (not per-message); use the larger VIDEO
    # values. Image enforces a shorter soft deadline internally.
    soft_time_limit=settings.MULTIMODAL_TASK_SOFT_TIME_LIMIT,
    time_limit=settings.MULTIMODAL_TASK_TIME_LIMIT,
    acks_late=True,
)
@trace_sync(
    span_name="multimodal_conversion",
    tracer_name="knowledge_doc_converter",
    extract_attributes=lambda self, document_id, **kw: {
        "multimodal.doc_id": document_id,
        "multimodal.attachment_id": kw.get("attachment_id"),
        "multimodal.media_type": kw.get("media_type"),
        "multimodal.ext": kw.get("file_extension"),
    },
)
def convert_multimodal_task(
    self: Task,
    *,
    document_id: int,
    knowledge_base_id: int,
    attachment_id: int,
    file_extension: str,
    media_type: str,  # "video" | "image"
    original_filename: str,
    # video-only: opaque vendor-specific source reference (None in the default
    # open-source build; internal deployments inject a CDN file id, etc.).
    video_source_ref: Optional[Dict[str, Any]] = None,
    # image-only: generic attachment download endpoint.
    content_download_path: Optional[str] = None,
    index_generation: int,
    callback_status_path: str,
    callback_completed_path: str,
    index_dispatch_payload: Dict[str, Any],
    # P5: model ref + uploader identity instead of the resolved/encrypted model
    # config. The converter calls model_config_resolve_path at execution time to
    # fetch the decrypted runtime config (no api_key on the broker).
    model_ref: Optional[Dict[str, Any]] = None,
    uploader_id: int = 0,
    uploader_name: Optional[str] = None,
    model_config_resolve_path: str = "",
    # Media staging config forwarded to the pluggable provider. Empty/None in
    # the default build (image still works via inline base64; video fails fast).
    media_staging_config: Optional[Dict[str, Any]] = None,
    # video-only: backend internal endpoint path the converter calls to resolve
    # a fresh short-lived download URL at execution time. None in the default
    # build; internal deployments inject the video source resolver path.
    video_download_url_path: Optional[str] = None,
    # video-only: staging proxy upload/delete paths. None in the default build.
    gcs_upload_path: Optional[str] = None,
    gcs_delete_path: Optional[str] = None,
    request_id: Optional[str] = None,
    # Resolved effective prompt (document override > KB default). When None/blank
    # the converter falls back to the shared default for this media_type.
    prompt_override: Optional[str] = None,
) -> Dict[str, Any]:
    """Convert a video/image to Markdown via Gemini and notify the backend."""
    if not settings.MULTIMODAL_ENABLED:
        raise Reject("multimodal pipeline disabled", requeue=False)

    if request_id:
        set_request_context(request_id)

    ext = (file_extension or "").lower().lstrip(".")
    media_type = (media_type or "image").lower()
    logger.info(
        "[MultimodalConversion] START doc_id=%s kb_id=%s media_type=%s ext=%s",
        document_id,
        knowledge_base_id,
        media_type,
        ext,
    )
    MULTIMODAL_ACTIVE.inc()
    t_start = time.perf_counter()
    # Image enforces a shorter in-task soft deadline so a slow image does not
    # occupy the worker for the full video-level soft_time_limit (30 min).
    image_deadline = (
        t_start + settings.MULTIMODAL_IMAGE_SOFT_TIME_LIMIT
        if media_type == "image"
        else None
    )

    def _image_deadline_exceeded() -> bool:
        """True if an image task has run past its shorter soft deadline."""
        # image_deadline is computed from time.perf_counter(); use the same
        # clock here. Mixing perf_counter and monotonic is incorrect even if
        # they happen to share a clock on Linux.
        return image_deadline is not None and time.perf_counter() > image_deadline

    staged_object_name: Optional[str] = None
    tmp_path: Optional[str] = None
    cfg: Dict[str, Any] = {}

    try:
        # 0. Resolve the runtime model config at execution time via the backend
        # internal endpoint (P5: no api_key / default_headers on the broker).
        if not model_ref or not model_config_resolve_path:
            raise PermanentError(
                "no_model_configured",
                "No multimodal analysis model configured (missing model_ref)",
            )
        try:
            cfg = get_model_config_fetcher().fetch(
                path=model_config_resolve_path,
                model_ref=model_ref,
                uploader_id=uploader_id,
                uploader_name=uploader_name,
                media_type=media_type,
            )
        except httpx.HTTPStatusError as exc:
            # 4xx from the resolve endpoint is a permanent misconfiguration
            # (model not found / no api_key / capability mismatch / invalid
            # model_ref) — do NOT retry. 5xx is transient (backend down).
            status = exc.response.status_code if exc.response is not None else 0
            if 400 <= status < 500:
                raise PermanentError(
                    "model_config_resolve_rejected",
                    f"Backend rejected model-config resolve (status={status}): "
                    f"{exc.response.text[:200] if exc.response is not None else ''}",
                ) from exc
            raise TransientError(
                "model_config_resolve_unavailable",
                f"Backend model-config resolve failed (status={status})",
            ) from exc
        if not cfg or not cfg.get("api_key"):
            raise PermanentError(
                "no_model_configured",
                "No multimodal analysis model configured (missing api_key)",
            )
        # max_output_tokens budget per media_type (video scenes > single image).
        if "max_output_tokens" not in cfg or not cfg.get("max_output_tokens"):
            cfg["max_output_tokens"] = (
                settings.MULTIMODAL_VIDEO_GEMINI_MAX_OUTPUT_TOKENS
                if media_type == "video"
                else settings.MULTIMODAL_IMAGE_GEMINI_MAX_OUTPUT_TOKENS
            )
        set_span_attribute("multimodal.model_id", cfg.get("model_id", ""))

        # 1. Notify backend the conversion has started AND gate the expensive
        # Gemini call on its response (stale-generation guard): if backend says
        # ok=false the task is no longer current (superseded / deleted /
        # re-queued), so abort BEFORE downloading media, staging, or calling
        # Gemini — don't burn money on a stale task.
        try:
            started_resp = callback_client.notify_started(
                path=callback_status_path,
                document_id=document_id,
                generation=index_generation,
            )
        except Exception as started_err:
            logger.warning(
                "[MultimodalConversion] notify_started failed doc_id=%s: %s",
                document_id,
                started_err,
            )
            started_resp = None

        if started_resp and not started_resp.get("ok"):
            raise PermanentError(
                "stale_generation",
                f"Task generation {index_generation} is stale or document no "
                f"longer current (notify_started ok=false)",
            )

        # 2. Fetch media bytes. Video uses a vendor-specific download URL resolver
        # (video_download_url_path); image uses the generic attachment endpoint.
        t0 = time.perf_counter()
        add_span_event("multimodal.download.start", {"media_type": media_type})
        image_bytes: Optional[bytes] = None
        if media_type == "video":
            if not video_download_url_path:
                raise PermanentError(
                    "video_no_download_path",
                    "Video task missing video_download_url_path "
                    "(no video source provider configured)",
                )
            # Resolve a fresh short-lived download URL at execution time via
            # the backend internal endpoint (bound to task execution, not queue
            # wait time). The converter calls the endpoint with the internal
            # service token.
            try:
                video_download_url = (
                    get_model_config_fetcher().fetch_video_download_url(
                        video_download_url_path
                    )
                )
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code if exc.response is not None else 0
                if 400 <= status < 500:
                    raise PermanentError(
                        "video_download_url_rejected",
                        f"Backend rejected video download URL resolve (status={status})",
                    ) from exc
                raise TransientError(
                    "video_download_url_unavailable",
                    f"Backend video download URL resolve failed (status={status})",
                ) from exc
            if not video_download_url:
                raise TransientError(
                    "video_download_url_unresolved",
                    "Failed to resolve video download URL at execution time",
                )
            tmp_path = _stream_download_to_tempfile(video_download_url, document_id)
            media_size = os.path.getsize(tmp_path)
            if media_size > settings.MULTIMODAL_VIDEO_MAX_BYTES:
                raise PermanentError(
                    "video_too_large",
                    f"Video size {media_size} exceeds max "
                    f"{settings.MULTIMODAL_VIDEO_MAX_BYTES}",
                )
        else:
            if not content_download_path:
                raise PermanentError(
                    "image_no_download_path",
                    "Image task missing content_download_path",
                )
            image_bytes = content_fetcher.download(content_download_path)
            media_size = len(image_bytes)
            if media_size > settings.MULTIMODAL_IMAGE_MAX_BYTES:
                raise PermanentError(
                    "image_too_large",
                    f"Image size {media_size} exceeds max "
                    f"{settings.MULTIMODAL_IMAGE_MAX_BYTES}",
                )
        add_span_event(
            "multimodal.download.done",
            {
                "bytes": media_size,
                "media_type": media_type,
                "duration_ms": int((time.perf_counter() - t0) * 1000),
            },
        )
        MULTIMODAL_STAGE_DURATION_SECONDS.labels(
            stage="download", file_extension=ext, media_type=media_type
        ).observe(time.perf_counter() - t0)
        MULTIMODAL_INPUT_BYTES.labels(
            file_extension=ext, media_type=media_type
        ).observe(media_size)

        # 3. Decide delivery: video → always staging; image → size threshold.
        use_staging = media_type == "video" or (
            media_size > settings.MULTIMODAL_INLINE_MAX_BYTES
        )
        delivery = "staging" if use_staging else "inline"
        media_uri: Optional[str] = None

        if use_staging:
            t0 = time.perf_counter()
            content_type = _mime_for_ext(ext, media_type)
            add_span_event("multimodal.staging_upload.start", {"size": media_size})
            # Image (in-memory) is spilled to a temp file so the same streaming
            # upload path is reused; video is already on a temp file.
            upload_tmp = tmp_path
            if image_bytes is not None:
                upload_tmp = _spill_bytes_to_tempfile(image_bytes, document_id, ext)
                tmp_path = upload_tmp
            if gcs_upload_path:
                # Internal deployments inject GCS proxy paths — upload via the
                # backend's internal GCS proxy (the converter has no TAuth2).
                staged = multimodal_conversion_coordinator.upload_via_proxy(
                    tmp_path=upload_tmp,
                    filename=original_filename,
                    content_type=content_type,
                    gcs_upload_path=gcs_upload_path,
                    gcs_resumable_base_path=_derive_resumable_base_path(
                        gcs_upload_path
                    ),
                    timeout_seconds=(
                        settings.MULTIMODAL_IMAGE_DOWNLOAD_TIMEOUT_SECONDS
                        if media_type == "image"
                        else settings.MULTIMODAL_DOWNLOAD_TIMEOUT_SECONDS
                    ),
                )
            else:
                # Open-source default: pluggable MediaStagingProvider (NoOp by
                # default → rejects with a clear "not configured" error).
                staging_provider = get_staging_provider(media_staging_config)
                staged = multimodal_conversion_coordinator.upload(
                    tmp_path=upload_tmp,
                    filename=original_filename,
                    content_type=content_type,
                    media_type=media_type,
                    staging_provider=staging_provider,
                    timeout_seconds=(
                        settings.MULTIMODAL_IMAGE_DOWNLOAD_TIMEOUT_SECONDS
                        if media_type == "image"
                        else None
                    ),
                )
            staged_object_name = staged["object_name"]
            media_uri = staged["gs_url"]
            set_span_attribute("multimodal.media_uri", media_uri)
            MULTIMODAL_STAGING_OPERATIONS_TOTAL.labels(
                op="upload", result="success", media_type=media_type
            ).inc()
            add_span_event(
                "multimodal.staging_upload.done",
                {"duration_ms": int((time.perf_counter() - t0) * 1000)},
            )
            MULTIMODAL_STAGE_DURATION_SECONDS.labels(
                stage="staging_upload", file_extension=ext, media_type=media_type
            ).observe(time.perf_counter() - t0)

        # 4. Gemini analysis (delivery + prompt diverge by media_type).
        t0 = time.perf_counter()
        analyzer = GeminiMultimodalAnalyzer(cfg)
        prompt = _select_prompt(media_type, original_filename, prompt_override)
        content_type = _mime_for_ext(ext, media_type)
        add_span_event(
            "multimodal.gemini.start",
            {"model": cfg.get("model_id", ""), "delivery": delivery},
        )
        try:
            if use_staging:
                markdown = analyzer.analyze_via_staging(
                    media_uri=media_uri, mime_type=content_type, prompt=prompt
                )
            else:
                markdown = analyzer.analyze_image_inline(
                    image_bytes=image_bytes,
                    mime_type=content_type,
                    prompt=prompt,
                )
        except PermanentError as exc:
            if (
                "safety" in str(exc).lower()
                or exc.error_class == "gemini_empty_response"
            ):
                MULTIMODAL_GEMINI_BLOCKED_TOTAL.labels(
                    block_reason="safety", media_type=media_type
                ).inc()
            MULTIMODAL_GEMINI_ERRORS_TOTAL.labels(
                error_type=exc.error_class, media_type=media_type
            ).inc()
            raise
        tokens_out = analyzer.last_tokens_out
        add_span_event(
            "multimodal.gemini.done",
            {
                "markdown_len": len(markdown),
                "tokens_out": tokens_out,
                "duration_ms": int((time.perf_counter() - t0) * 1000),
            },
        )
        MULTIMODAL_STAGE_DURATION_SECONDS.labels(
            stage="gemini", file_extension=ext, media_type=media_type
        ).observe(time.perf_counter() - t0)
        MULTIMODAL_OUTPUT_BYTES.labels(
            file_extension=ext, media_type=media_type
        ).observe(len(markdown.encode("utf-8")))

        # Proactive image-deadline check on the SUCCESS path.
        if _image_deadline_exceeded():
            logger.warning(
                "[MultimodalConversion] image soft deadline exceeded after gemini "
                "doc_id=%s — accepting result but skipping no further wait",
                document_id,
            )

        # 5. Notify backend completed → backend writes the Markdown attachment
        #    and dispatches indexing (reuses the conversion callback endpoint).
        md_bytes = markdown.encode("utf-8")
        callback_client.notify_completed(
            path=callback_completed_path,
            document_id=document_id,
            generation=index_generation,
            converted_name=f"{document_id}.{media_type}.md",
            converted_extension="md",
            file_size=len(md_bytes),
            markdown_bytes=md_bytes,
            index_dispatch_payload=index_dispatch_payload,
        )
        add_span_event("multimodal.callback.completed", {"md_size": len(md_bytes)})

        MULTIMODAL_CONVERSIONS_TOTAL.labels(
            result="success",
            model_type=cfg.get("model_type", "unknown"),
            model=cfg.get("model_id", ""),
            file_extension=ext,
            media_type=media_type,
            delivery=delivery,
        ).inc()
        key_fingerprint = hashlib.sha256(
            cfg.get("api_key", "").encode("utf-8")
        ).hexdigest()[:8]
        logger.info(
            "[MultimodalConversion] COMPLETED doc_id=%s media_type=%s delivery=%s "
            "duration_ms=%d key_fp=%s",
            document_id,
            media_type,
            delivery,
            int((time.perf_counter() - t_start) * 1000),
            key_fingerprint,
        )
        return {"status": "converted", "document_id": document_id}

    except TransientError as exc:
        if _image_deadline_exceeded():
            _safe_notify_failed(
                callback_status_path,
                document_id,
                index_generation,
                "image_soft_deadline_exceeded",
            )
            _record_failure(ext, media_type)
            logger.warning(
                "[MultimodalConversion] image soft deadline exceeded (transient) "
                "doc_id=%s",
                document_id,
            )
            return {"status": "failed", "reason": "image_soft_deadline_exceeded"}

        if self.request.retries >= settings.MULTIMODAL_RETRY_MAX:
            _safe_notify_failed(
                callback_status_path,
                document_id,
                index_generation,
                f"transient_exhausted:{exc.error_class}",
            )
            _record_failure(ext, media_type)
            logger.error(
                "[MultimodalConversion] transient retries exhausted doc_id=%s: %s",
                document_id,
                exc,
            )
            return {"status": "failed", "reason": "transient_exhausted"}

        logger.warning(
            "[MultimodalConversion] transient error doc_id=%s: %s", document_id, exc
        )
        MULTIMODAL_CONVERSIONS_TOTAL.labels(
            result="retrying",
            model_type="n/a",
            model="",
            file_extension=ext,
            media_type=media_type,
            delivery="n/a",
        ).inc()
        raise self.retry(exc=exc, countdown=settings.MULTIMODAL_RETRY_COUNTDOWN_SECONDS)

    except SoftTimeLimitExceeded:
        _safe_notify_failed(
            callback_status_path,
            document_id,
            index_generation,
            "multimodal_soft_timeout",
        )
        _record_failure(ext, media_type)
        logger.warning("[MultimodalConversion] soft timeout doc_id=%s", document_id)
        return {"status": "failed", "reason": "soft_timeout"}

    except (PermanentError, Reject) as exc:
        _safe_notify_failed(
            callback_status_path,
            document_id,
            index_generation,
            f"{getattr(exc, 'error_class', 'permanent')}:{exc}",
        )
        _record_failure(ext, media_type)
        logger.error(
            "[MultimodalConversion] permanent failure doc_id=%s: %s", document_id, exc
        )
        return {
            "status": "failed",
            "reason": getattr(exc, "error_class", "permanent"),
        }

    except Exception as exc:
        if _image_deadline_exceeded():
            _safe_notify_failed(
                callback_status_path,
                document_id,
                index_generation,
                "image_soft_deadline_exceeded",
            )
            _record_failure(ext, media_type)
            logger.warning(
                "[MultimodalConversion] image soft deadline exceeded doc_id=%s",
                document_id,
            )
            return {"status": "failed", "reason": "image_soft_deadline_exceeded"}

        if self.request.retries < settings.MULTIMODAL_RETRY_MAX:
            logger.warning(
                "[MultimodalConversion] retrying unknown error doc_id=%s: %s",
                document_id,
                exc,
            )
            raise self.retry(exc=exc)
        _safe_notify_failed(
            callback_status_path, document_id, index_generation, str(exc)
        )
        _record_failure(ext, media_type)
        logger.error(
            "[MultimodalConversion] unknown failure doc_id=%s: %s",
            document_id,
            exc,
            exc_info=True,
        )
        raise

    finally:
        # Clean up temp file + staged object + clear plaintext key.
        MULTIMODAL_ACTIVE.dec()
        MULTIMODAL_DURATION_SECONDS.labels(
            file_extension=ext, media_type=media_type
        ).observe(time.perf_counter() - t_start)
        if staged_object_name:
            if gcs_delete_path:
                multimodal_conversion_coordinator.delete_via_proxy(
                    gcs_delete_path=gcs_delete_path,
                    object_name=staged_object_name,
                )
            else:
                staging_provider = get_staging_provider(media_staging_config)
                multimodal_conversion_coordinator.delete(
                    staging_provider=staging_provider,
                    object_name=staged_object_name,
                )
        if tmp_path:
            _safe_remove_tmp(tmp_path)
        cfg["api_key"] = None


def _record_failure(ext: str, media_type: str) -> None:
    """Record a failed-conversion metric (shared by all failure paths)."""
    MULTIMODAL_CONVERSIONS_TOTAL.labels(
        result="failed",
        model_type="n/a",
        model="",
        file_extension=ext,
        media_type=media_type,
        delivery="n/a",
    ).inc()


def _derive_resumable_base_path(gcs_upload_path: str) -> str:
    """Derive the resumable endpoint base path from the simple upload path."""
    if gcs_upload_path.endswith("/upload"):
        return gcs_upload_path[: -len("/upload")] + "/upload-resumable"
    return gcs_upload_path.rstrip("/").rsplit("/upload", 1)[0] + "/upload-resumable"


def _stream_download_to_tempfile(download_url: str, doc_id: int) -> str:
    """Stream-download ``download_url`` to a unique temp file (peak ~1 MiB)."""
    fd, tmp_path = tempfile.mkstemp(
        prefix=f"wegent-multimodal-doc{doc_id}-pid{os.getpid()}-",
        suffix=".bin",
    )
    os.close(fd)
    try:
        with httpx.stream(
            "GET",
            download_url,
            timeout=settings.MULTIMODAL_DOWNLOAD_TIMEOUT_SECONDS,
            follow_redirects=True,
        ) as resp:
            resp.raise_for_status()
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_bytes(settings.MULTIMODAL_DOWNLOAD_CHUNK_BYTES):
                    f.write(chunk)
        return tmp_path
    except Exception:
        _safe_remove_tmp(tmp_path)
        raise


def _select_prompt(
    media_type: str,
    original_filename: str,
    prompt_override: Optional[str] = None,
) -> str:
    """Choose the analysis prompt.

    Precedence: ``prompt_override`` (the document/KB-resolved effective prompt)
    wins over the shared default. A blank/whitespace override is ignored so an
    empty override falls back to the default (defensive). For video the
    ``{{VIDEO_FILENAME}}`` placeholder is substituted with the original
    filename's stem in BOTH the default and any override that includes it.
    """
    override = (prompt_override or "").strip()
    if override:
        text: str = override
    else:
        text = DEFAULT_VIDEO_PROMPT if media_type == "video" else DEFAULT_IMAGE_PROMPT
    if media_type == "video":
        text = text.replace(
            "{{VIDEO_FILENAME}}", os.path.splitext(original_filename)[0]
        )
    return text


def _spill_bytes_to_tempfile(data: bytes, doc_id: int, ext: str) -> str:
    """Write in-memory image bytes to a temp file for the streaming upload."""
    suffix = f".{ext}" if ext else ".bin"
    fd, tmp_path = tempfile.mkstemp(
        prefix=f"wegent-multimodal-image-doc{doc_id}-pid{os.getpid()}-",
        suffix=suffix,
    )
    os.close(fd)
    try:
        with open(tmp_path, "wb") as f:
            f.write(data)
        return tmp_path
    except Exception:
        _safe_remove_tmp(tmp_path)
        raise


def _safe_notify_failed(
    path: str, document_id: int, generation: int, error_message: str
) -> None:
    """Notify backend of failure; never raise (we're already handling an error)."""
    try:
        callback_client.notify_failed(
            path=path,
            document_id=document_id,
            generation=generation,
            error_message=error_message,
        )
    except Exception as callback_err:
        logger.error(
            "[MultimodalConversion] failed to notify backend of failure: %s",
            callback_err,
        )


def _safe_remove_tmp(tmp_path: str) -> None:
    """Remove a temp file, ignoring missing-file errors."""
    try:
        os.remove(tmp_path)
    except FileNotFoundError:
        pass
    except Exception as cleanup_exc:
        logger.warning(
            "[MultimodalConversion] temp file cleanup failed path=%s error=%s",
            tmp_path,
            cleanup_exc,
        )


def _mime_for_ext(ext: str, media_type: str) -> str:
    """Return the MIME type for an extension, scoped by media_type."""
    if media_type == "video":
        return _VIDEO_MIME_BY_EXT.get(ext, "video/mp4")
    return _IMAGE_MIME_BY_EXT.get(ext, "image/jpeg")
