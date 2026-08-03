"""Safe, structured errors for knowledge document processing."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from app.schemas.knowledge import (
    DocumentProcessingError,
    DocumentProcessingStage,
)


def build_processing_error(
    *,
    stage: DocumentProcessingStage,
    code: str,
    message: str,
    retryable: bool,
    generation: int,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    request_id: Optional[str] = None,
) -> DocumentProcessingError:
    """Build and validate a user-safe processing error."""
    return DocumentProcessingError(
        stage=stage,
        code=code,
        message=message,
        retryable=retryable,
        generation=generation,
        occurred_at=datetime.now(timezone.utc),
        provider=provider,
        model=model,
        request_id=request_id,
    )


def generic_processing_error(
    *, generation: int, stage: DocumentProcessingStage
) -> DocumentProcessingError:
    """Return a guaranteed-valid fallback error."""
    return build_processing_error(
        stage=stage,
        code="processing_failed",
        message="Document processing failed. Please retry.",
        retryable=True,
        generation=generation,
    )


def map_legacy_conversion_error(
    error_message: Optional[str], *, generation: int
) -> DocumentProcessingError:
    """Map an old converter error string to a safe public error.

    This compatibility mapper only supports converters that do not yet send
    ``error_code`` and ``user_message``.  New classifications belong in the
    converter's structured mapper and should not be mirrored here.  Remove
    this function after the legacy callback protocol is retired.
    """
    normalized = (error_message or "").lower()
    if "quota" in normalized or "额度已用完" in normalized:
        return build_processing_error(
            stage=DocumentProcessingStage.CONVERSION,
            code="model_quota_exhausted",
            message=(
                "The selected model quota has been exhausted. "
                "Switch models or contact an administrator."
            ),
            retryable=False,
            generation=generation,
        )
    if "permission_denied" in normalized or "permission denied" in normalized:
        return build_processing_error(
            stage=DocumentProcessingStage.CONVERSION,
            code="model_permission_denied",
            message=(
                "The selected model is not available to the current account. "
                "Check its permissions or select another model."
            ),
            retryable=False,
            generation=generation,
        )
    if "timeout" in normalized or "deadline" in normalized:
        return build_processing_error(
            stage=DocumentProcessingStage.CONVERSION,
            code="conversion_timeout",
            message="Document conversion timed out. Please retry.",
            retryable=True,
            generation=generation,
        )
    if "readerror" in normalized or "connecterror" in normalized:
        return build_processing_error(
            stage=DocumentProcessingStage.CONVERSION,
            code="conversion_service_unavailable",
            message=(
                "The document conversion service could not be reached. "
                "Please retry later."
            ),
            retryable=True,
            generation=generation,
        )
    return build_processing_error(
        stage=DocumentProcessingStage.CONVERSION,
        code="conversion_failed",
        message="Document conversion failed. Please retry.",
        retryable=True,
        generation=generation,
    )


def map_indexing_exception(
    exc: Exception, *, generation: int
) -> DocumentProcessingError:
    """Map an indexing exception without exposing its raw message."""
    normalized = str(exc).lower()
    if "timeout" in normalized or "deadline" in normalized:
        return build_processing_error(
            stage=DocumentProcessingStage.INDEXING,
            code="indexing_timeout",
            message="Document indexing timed out. Please retry.",
            retryable=True,
            generation=generation,
        )
    return build_processing_error(
        stage=DocumentProcessingStage.INDEXING,
        code="indexing_failed",
        message="Document indexing failed. Please retry.",
        retryable=True,
        generation=generation,
    )
