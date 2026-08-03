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
    if "readerror" in normalized or "connecterror" in normalized:
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
