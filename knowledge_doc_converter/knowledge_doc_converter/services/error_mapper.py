"""Map converter failures to safe structured callback fields.

This is the authoritative classifier for the converter's structured error
protocol.  The backend intentionally keeps a separate, frozen compatibility
mapper for converters that still send only ``error_message``; new
classifications should be emitted here through ``error_code`` rather than
mirrored into that legacy mapper.
"""

import re
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ConversionFailure:
    """User-safe representation of a terminal conversion failure."""

    code: str
    user_message: str
    retryable: bool
    provider: Optional[str] = None
    model: Optional[str] = None


_MULTIMODAL_FAILURES = {
    "gemini_auth": (
        "model_permission_denied",
        "The selected model is not available to the current account. "
        "Check its permissions or select another model.",
    ),
    "gemini_quota": (
        "model_quota_exhausted",
        "The selected model quota has been exhausted. "
        "Switch models or contact an administrator.",
    ),
    "gemini_empty_response": (
        "multimodal_empty_response",
        "The multimodal model returned no usable content. "
        "Check the document or select another model.",
    ),
    "no_model_configured": (
        "multimodal_model_unavailable",
        "The multimodal model is not configured or available. "
        "Check the knowledge base model settings.",
    ),
    "model_config_resolve_rejected": (
        "multimodal_model_unavailable",
        "The multimodal model is not configured or available. "
        "Check the knowledge base model settings.",
    ),
    "video_too_large": (
        "multimodal_file_too_large",
        "The media file is too large for multimodal processing.",
    ),
    "image_too_large": (
        "multimodal_file_too_large",
        "The media file is too large for multimodal processing.",
    ),
    "staging_file_too_large": (
        "multimodal_file_too_large",
        "The media file is too large for multimodal processing.",
    ),
    "video_staging_not_configured": (
        "conversion_configuration_error",
        "The document conversion service is not configured correctly. "
        "Contact an administrator.",
    ),
    "staging_auth_error": (
        "conversion_configuration_error",
        "The document conversion service is not configured correctly. "
        "Contact an administrator.",
    ),
    "staging_invalid_descriptor": (
        "conversion_configuration_error",
        "The document conversion service is not configured correctly. "
        "Contact an administrator.",
    ),
    "staging_invalid_response": (
        "conversion_configuration_error",
        "The document conversion service is not configured correctly. "
        "Contact an administrator.",
    ),
}


def map_conversion_failure(
    error_message: str, *, provider: Optional[str] = None, model: Optional[str] = None
) -> ConversionFailure:
    """Classify a terminal converter message without exposing it to users."""
    normalized = error_message.lower()
    if model is None:
        match = re.search(
            r"(?:model_id\s*:\s*|model\s+['\"])([A-Za-z0-9._/-]+)",
            error_message,
            flags=re.IGNORECASE,
        )
        model = match.group(1) if match else None
    if "quota" in normalized or "额度已用完" in normalized:
        return ConversionFailure(
            code="model_quota_exhausted",
            user_message=(
                "The selected model quota has been exhausted. "
                "Switch models or contact an administrator."
            ),
            retryable=False,
            provider=provider,
            model=model,
        )
    if "permission_denied" in normalized or "permission denied" in normalized:
        return ConversionFailure(
            code="model_permission_denied",
            user_message=(
                "The selected model is not available to the current account. "
                "Check its permissions or select another model."
            ),
            retryable=False,
            provider=provider,
            model=model,
        )
    if "timeout" in normalized or "deadline" in normalized:
        return ConversionFailure(
            code="conversion_timeout",
            user_message="Document conversion timed out. Please retry.",
            retryable=True,
            provider=provider,
            model=model,
        )
    if any(
        error_name in normalized
        for error_name in ("readerror", "connecterror", "remoteprotocolerror")
    ):
        return ConversionFailure(
            code="conversion_service_unavailable",
            user_message=(
                "The document conversion service could not be reached. "
                "Please retry later."
            ),
            retryable=True,
            provider=provider,
            model=model,
        )
    return ConversionFailure(
        code="conversion_failed",
        user_message="Document conversion failed. Please retry.",
        retryable=True,
        provider=provider,
        model=model,
    )


def map_multimodal_failure(
    error_class: str,
    *,
    retryable: bool,
    provider: str = "gemini",
    model: Optional[str] = None,
) -> ConversionFailure:
    """Map an already-classified multimodal failure to the public contract."""
    mapped = _MULTIMODAL_FAILURES.get(error_class)
    if mapped:
        code, user_message = mapped
        return ConversionFailure(
            code=code,
            user_message=user_message,
            retryable=False,
            provider=provider,
            model=model,
        )
    if "timeout" in error_class or "deadline" in error_class:
        return ConversionFailure(
            code="conversion_timeout",
            user_message="Document conversion timed out. Please retry.",
            retryable=retryable,
            provider=provider,
            model=model,
        )
    if retryable:
        return ConversionFailure(
            code="conversion_service_unavailable",
            user_message=(
                "The document conversion service could not be reached. "
                "Please retry later."
            ),
            retryable=True,
            provider=provider,
            model=model,
        )
    return ConversionFailure(
        code="conversion_failed",
        user_message="Document conversion failed. Check the configuration or document.",
        retryable=False,
        provider=provider,
        model=model,
    )
