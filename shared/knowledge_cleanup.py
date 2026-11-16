# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Content deletion and externally confirmed index cleanup are independent facts."""

from typing import Literal

from pydantic import BaseModel

EXTERNAL_CLEANUP_ERROR = "external_engine_unavailable"
CLEANUP_REASONS = frozenset({"connection_failed", "timeout", "authentication_failed"})
STORAGE_TYPES = frozenset({"qdrant", "elasticsearch", "milvus"})


class ExternalEngineCleanupError(RuntimeError):
    """A recognized external SDK failure, without connection or credential data."""

    def __init__(self, storage_type: str, reason: str) -> None:
        super().__init__("External index cleanup could not be confirmed")
        self.storage_type = storage_type
        self.reason = reason

    @property
    def details(self) -> dict[str, str]:
        return {
            "stage": "external_index_cleanup",
            "storage_type": self.storage_type,
            "reason": self.reason,
        }


class ContentDeletionOutcome(BaseModel):
    """Only committed content removal may be reported as deleted."""

    content_deleted: bool = False
    index_cleanup: Literal["confirmed", "unconfirmed", "not_applicable"] = (
        "not_applicable"
    )
    error_code: str | None = None
    can_continue: bool = False


def is_external_cleanup_failure(code: str, details: dict | None) -> bool:
    """Accept only the management protocol's explicit external failure envelope."""
    return bool(
        code == EXTERNAL_CLEANUP_ERROR
        and isinstance(details, dict)
        and details.get("stage") == "external_index_cleanup"
        and isinstance(details.get("storage_type"), str)
        and details["storage_type"] in STORAGE_TYPES
        and isinstance(details.get("reason"), str)
        and details["reason"] in CLEANUP_REASONS
    )
