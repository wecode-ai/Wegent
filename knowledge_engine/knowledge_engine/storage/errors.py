# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic storage errors shared by the storage adapters."""

from __future__ import annotations

from typing import Any


class StorageBackendError(RuntimeError):
    """Base class for storage failures that carry a stable error code.

    ``retryable`` says whether the caller may run the same operation again.
    Subclasses state their own default; a failure that needs retrying although
    its class is deterministic says so at construction.
    """

    code = "storage_backend_error"
    retryable = False

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        retryable: bool | None = None,
    ) -> None:
        self.details = details or {}
        if retryable is not None:
            self.retryable = retryable
        super().__init__(message)


class UnsupportedStorageCapabilityError(StorageBackendError):
    """Raised when a requested capability is not implemented for a backend."""

    code = "storage_capability_unsupported"
    retryable = False

    def __init__(self, capability: str, *, backend: str) -> None:
        super().__init__(
            f"Storage backend '{backend}' does not support '{capability}' yet.",
            details={"capability": capability, "backend": backend},
        )


class StorageUnavailableError(StorageBackendError):
    """Raised when the storage service could not answer a bounded operation.

    This is the transient class: the server may be disconnected or too slow for
    the deadline. It says nothing about whether the remote side applied the
    request, so a caller may retry the whole operation but must not report the
    attempt as cancelled or unwritten.
    """

    code = "storage_unavailable"
    retryable = True

    def __init__(self, backend: str, *, details: dict[str, Any] | None = None) -> None:
        merged_details = {"backend": backend}
        merged_details.update(details or {})
        sdk_error = merged_details.get("sdk_error")
        sdk_code = merged_details.get("sdk_code")
        classification = (
            f"{sdk_error} (code={sdk_code})" if sdk_error else "no SDK classification"
        )
        super().__init__(
            f"Storage backend '{backend}' could not complete this operation "
            f"within its bound: {classification}. The remote result is unknown; "
            "retry the whole operation and do not assume it was cancelled or "
            "unwritten.",
            details=merged_details,
        )
