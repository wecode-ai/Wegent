# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic storage errors shared by the storage adapters."""

from __future__ import annotations

from typing import Any


class StorageBackendError(RuntimeError):
    """Base class for storage failures that carry a stable error code."""

    code = "storage_backend_error"
    retryable = False

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        self.details = details or {}
        super().__init__(message)


class IndexContractIncompatibleError(StorageBackendError):
    """Raised when an existing physical index cannot serve the requested space."""

    code = "index_contract_incompatible"
    retryable = False

    def __init__(
        self,
        collection_name: str,
        reason: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        merged_details = {"collection_name": collection_name, "reason": reason}
        merged_details.update(details or {})
        super().__init__(
            f"Milvus index '{collection_name}' is not compatible: {reason}. "
            "This index requires an explicit operational decision; it is never "
            "overwritten or adopted automatically.",
            details=merged_details,
        )


class UnsupportedStorageCapabilityError(StorageBackendError):
    """Raised when a requested capability is not implemented for a backend."""

    code = "storage_capability_unsupported"
    retryable = False

    def __init__(self, capability: str, *, backend: str) -> None:
        super().__init__(
            f"Storage backend '{backend}' does not support '{capability}' yet.",
            details={"capability": capability, "backend": backend},
        )


class IndexMissingError(StorageBackendError):
    """Raised when a confirmed physical index disappeared from the service."""

    code = "index_missing"
    retryable = False

    def __init__(self, collection_name: str, reason: str) -> None:
        super().__init__(
            f"Milvus index '{collection_name}' is missing: {reason}. "
            "A knowledge base with a confirmed index must not degrade into an "
            "empty result; this needs an operational decision.",
            details={"collection_name": collection_name, "reason": reason},
        )


class IndexRollbackError(StorageBackendError):
    """Raised when a failed publication could not be rolled back."""

    code = "index_rollback_failed"
    retryable = True

    def __init__(
        self,
        collection_name: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        merged_details = {"collection_name": collection_name}
        merged_details.update(details or {})
        super().__init__(
            f"Milvus index '{collection_name}' could not be rolled back after a "
            "failed publication; the index may be visible while the business "
            "state says the write failed. Re-run the same execution.",
            details=merged_details,
        )
