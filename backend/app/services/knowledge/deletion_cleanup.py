# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index cleanup policy after the caller's content deletion authorization."""

from collections.abc import Callable
from typing import Any

from app.services.rag.remote_gateway import RemoteRagGatewayError
from shared.knowledge_cleanup import (
    EXTERNAL_CLEANUP_ERROR,
    ContentDeletionOutcome,
    is_external_cleanup_failure,
)


class IndexCleanupConfirmationRequired(RemoteRagGatewayError):
    """The target was authorized but its external cleanup could not be confirmed."""

    def __init__(self) -> None:
        super().__init__(
            "External index cleanup could not be confirmed",
            code=EXTERNAL_CLEANUP_ERROR,
            status_code=502,
        )


def requires_index_cleanup(spec: dict[str, Any]) -> bool:
    """Absent indexing is legitimate; a broken stored configuration is not."""
    config = spec.get("retrievalConfig")
    if config is None:
        return False
    if not isinstance(config, dict) or not config.get("retriever_name"):
        raise RuntimeError("Knowledge base retrieval configuration is incomplete")
    return True


def clean_external_index(
    operation: Callable[[], dict[str, Any]],
    *,
    continue_on_failure: bool,
    failure_message: str = "RAG index removal did not complete",
) -> ContentDeletionOutcome:
    try:
        result = operation()
    except RemoteRagGatewayError as error:
        if error.status_code != 502 or not is_external_cleanup_failure(
            error.code, error.details
        ):
            raise
        if not continue_on_failure:
            raise IndexCleanupConfirmationRequired() from error
        return ContentDeletionOutcome(
            index_cleanup="unconfirmed", error_code=EXTERNAL_CLEANUP_ERROR
        )
    if (result or {}).get("status") not in {"success", "deleted"}:
        reason = (result or {}).get("reason") or (result or {}).get("status")
        safe_reason = (
            reason
            if isinstance(reason, str)
            and len(reason) <= 64
            and reason.replace("_", "").isalnum()
            else "unknown"
        )
        raise RuntimeError(f"{failure_message}: {safe_reason}")
    return ContentDeletionOutcome(index_cleanup="confirmed")
