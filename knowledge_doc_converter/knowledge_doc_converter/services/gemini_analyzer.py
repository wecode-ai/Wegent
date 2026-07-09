# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Unified Gemini multimodal analyzer — serves BOTH video and image.

One analyzer, two delivery modes:
- ``analyze_via_staging``: ``{"type": "media", "file_uri": <uri>, "mime_type":
  ...}`` part. Used by video (always — large files must be staged) and by large
  images (> MULTIMODAL_INLINE_MAX_BYTES). The URI is supplied by the pluggable
  :class:`MediaStagingProvider` (NoOp by default → video/large-image path fails
  fast with a clear "staging not configured" error).
- ``analyze_image_inline``: ``{"type": "image_url", "image_url": {"url":
  data:...}}`` part. Used by small images, after preprocessing via the shared
  ``image_preprocessor`` (≤1568px long edge, ≤1MB). This path is fully
  functional in the open-source build.

Verified SDK construction: ``ChatGoogleGenerativeAI``.
Verified gs:// consumption: ``{"type": "media", "file_uri": "gs://...",
"mime_type": ...}`` part.
Verified image consumption: ``image_url`` data URL.

Error classification:
- 401/403/permission → :class:`PermanentError` (gemini_auth) — bad key, fail fast.
- 429/quota_exhausted → :class:`PermanentError` (gemini_quota) — retrying wastes money.
- 5xx/overloaded/timeout → :class:`TransientError` (gemini_server) — Celery retries.
- empty/blocked response → :class:`PermanentError` (gemini_empty_response).
"""

from __future__ import annotations

import base64
import logging
from typing import Any, Dict, Optional

from langchain_core.messages import HumanMessage
from langchain_google_genai import ChatGoogleGenerativeAI

from knowledge_doc_converter.config import settings
from knowledge_doc_converter.services.errors import (
    PermanentError,
    TransientError,
    VideoAnalysisError,
)
from shared.utils.image_preprocessor import (
    MAX_MODEL_IMAGE_LONG_EDGE,
    prepare_image_bytes_for_model,
)

logger = logging.getLogger(__name__)

# Inline image preprocessing budget (matches chat_shell MAX_IMAGE_* constants).
_MAX_INLINE_IMAGE_BYTES = 1024 * 1024  # 1 MB after preprocessing

# Substrings that identify error categories in the SDK's exception text. The
# google-genai SDK raises generic exceptions whose messages embed the status.
_AUTH_MARKERS = ("401", "403", "api key", "api_key", "permission", "unauthorized")
_QUOTA_MARKERS = ("429", "rate limit", "rate_limit", "quota_exhausted", "quota")
_TRANSIENT_MARKERS = (
    "500",
    "502",
    "503",
    "504",
    "overloaded",
    "timeout",
    "unavailable",
    "temporarily",
)


class GeminiMultimodalAnalyzer:
    """Analyze video (staged URI) or image (inline base64 / staged URI) via Gemini.

    The constructor takes the model config resolved by the backend
    (``extract_and_process_model_config`` output + ``model_type`` for billing).
    ``max_output_tokens`` is chosen by the caller per media_type (video scenes
    are longer than a single image).
    """

    def __init__(self, cfg: Dict[str, Any]):
        self._cfg = cfg
        self.last_tokens_out: Optional[int] = None

        # cfg comes from extract_and_process_model_config, where temperature /
        # max_output_tokens are present but may be None (unset in the model
        # spec). Use `or` so None falls back to the service default — .get(key,
        # default) would return None when the key exists with a None value, and
        # ChatGoogleGenerativeAI rejects temperature=None (pydantic float_type).
        params: Dict[str, Any] = {
            "model": cfg["model_id"],
            "google_api_key": cfg["api_key"],
            "temperature": cfg.get("temperature")
            or settings.MULTIMODAL_GEMINI_TEMPERATURE,
            "max_output_tokens": cfg.get("max_output_tokens")
            or settings.MULTIMODAL_VIDEO_GEMINI_MAX_OUTPUT_TOKENS,
            "streaming": False,
        }
        base_url = cfg.get("base_url")
        if base_url:
            params["base_url"] = base_url
        default_headers = cfg.get("default_headers")
        if default_headers:
            params["additional_headers"] = default_headers
        self._llm = ChatGoogleGenerativeAI(**params)

    def analyze_via_staging(
        self, *, media_uri: str, mime_type: str, prompt: str
    ) -> str:
        """Invoke Gemini with a staged media part (``gs://`` / ``https://``) + prompt.

        Used by video (always) and large images (> inline threshold). The URI is
        supplied by the :class:`MediaStagingProvider`; the NoOp default raises
        before reaching here, so this method is only reached when a concrete
        provider is configured. Returns the extracted Markdown.
        """
        msg = HumanMessage(
            content=[
                {"type": "media", "file_uri": media_uri, "mime_type": mime_type},
                {"type": "text", "text": prompt},
            ]
        )
        return self._invoke(msg, source=media_uri)

    def analyze_image_inline(
        self, *, image_bytes: bytes, mime_type: str, prompt: str
    ) -> str:
        """Invoke Gemini with an inline base64 image_url part + text prompt.

        Used by small images (≤ MULTIMODAL_INLINE_MAX_BYTES). The image is first
        preprocessed via the shared ``image_preprocessor`` (resize/compress to
        the model budget), so Gemini reliably consumes it. Fully functional in
        the open-source build.
        """
        prepared = prepare_image_bytes_for_model(
            image_bytes,
            mime_type,
            max_long_edge=MAX_MODEL_IMAGE_LONG_EDGE,
            max_size_bytes=_MAX_INLINE_IMAGE_BYTES,
        )
        data_url = (
            f"data:{prepared.mime_type};base64,"
            f"{base64.b64encode(prepared.data).decode('utf-8')}"
        )
        msg = HumanMessage(
            content=[
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": prompt},
            ]
        )
        return self._invoke(msg, source="(inline)")

    def _invoke(self, msg: HumanMessage, *, source: str) -> str:
        """Shared invoke + response extraction + error classification."""
        logger.info(
            "[GeminiMultimodalAnalyzer] invoking model=%s source=%s",
            self._cfg.get("model_id", ""),
            source,
        )
        logger.debug(
            "[GeminiMultimodalAnalyzer] request model=%s content=%s",
            self._cfg.get("model_id", ""),
            self._format_request_for_log(msg),
        )
        try:
            resp = self._llm.invoke([msg])
        except Exception as e:
            raise self._classify_error(e) from e

        # Gemini 2.5 thinking models return AIMessage.content as a list of
        # content blocks rather than a plain string. Extract the text from text
        # blocks; skip thought/reasoning blocks so we don't store internal
        # reasoning as the document content.
        text = self._extract_text(resp)
        self.last_tokens_out = self._extract_tokens_out(resp)

        if not text:
            raise PermanentError(
                "gemini_empty_response",
                "Gemini returned empty (possibly safety-blocked)",
            )
        logger.info(
            "[GeminiMultimodalAnalyzer] analyzed source=%s markdown_len=%d tokens_out=%s",
            source,
            len(text),
            self.last_tokens_out,
        )
        return text

    @staticmethod
    def _format_request_for_log(msg: HumanMessage) -> str:
        """Format a request message for DEBUG logging (data: URLs truncated)."""
        content = msg.content
        blocks = content if isinstance(content, list) else [content]
        parts: list[str] = []
        for block in blocks:
            if isinstance(block, str):
                parts.append(block)
                continue
            if not isinstance(block, dict):
                parts.append(str(block))
                continue
            btype = block.get("type")
            if btype == "text":
                parts.append(f"text={block.get('text', '')!r}")
            elif btype == "media":
                parts.append(
                    f"media(file_uri={block.get('file_uri')!r},"
                    f"mime_type={block.get('mime_type')!r})"
                )
            elif btype == "image_url":
                url = ((block.get("image_url") or {}).get("url", "")) or ""
                if url.startswith("data:"):
                    header = url.split(",", 1)[0]
                    parts.append(f"image_url({header},<+{len(url)} bytes>)")
                else:
                    parts.append(f"image_url({url!r})")
            else:
                parts.append(f"{btype}={str(block)[:120]!r}")
        return " ".join(parts)

    @staticmethod
    def _extract_text(resp: Any) -> str:
        """Extract answer text from an AIMessage, handling both str and list content."""
        content = getattr(resp, "content", None)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                    continue
                if not isinstance(block, dict):
                    continue
                # Skip reasoning/thought blocks — keep only the answer text.
                if block.get("type") in ("thought", "thinking"):
                    continue
                block_text = block.get("text")
                if isinstance(block_text, str) and block_text:
                    parts.append(block_text)
            return "\n".join(parts)
        return str(content) if content is not None else ""

    @staticmethod
    def _classify_error(exc: Exception) -> VideoAnalysisError:
        """Map a raw SDK exception to a Transient/Permanent error."""
        msg_lower = str(exc).lower()
        if any(k in msg_lower for k in _AUTH_MARKERS):
            return PermanentError("gemini_auth", f"Gemini auth error: {exc}")
        if any(k in msg_lower for k in _QUOTA_MARKERS):
            return PermanentError("gemini_quota", f"Gemini quota exhausted: {exc}")
        if any(k in msg_lower for k in _TRANSIENT_MARKERS):
            return TransientError("gemini_server", f"Gemini server error: {exc}")
        return PermanentError("gemini_unknown", f"Gemini error: {exc}")

    @staticmethod
    def _extract_tokens_out(resp: Any) -> Optional[int]:
        """Best-effort extraction of output token count from the SDK response."""
        usage = getattr(resp, "usage_metadata", None)
        if usage is None:
            return None
        for key in ("candidates_token_count", "candidatesTokenCount"):
            value = getattr(usage, key, None)
            if value is not None:
                return int(value)
        if isinstance(usage, dict):
            for key in ("candidates_token_count", "candidatesTokenCount"):
                if key in usage:
                    return int(usage[key])
        return None
