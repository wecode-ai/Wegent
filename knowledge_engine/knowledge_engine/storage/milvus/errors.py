# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Classification of PyMilvus RPC failures into stable storage errors.

Keeping this separate from the Milvus adapter's request lifecycle keeps the
one question that matters here - could the server answer this attempt? - out
of the code that owns schema, filters and the shared connection.
"""

from __future__ import annotations

from typing import Any

import grpc
from pymilvus.client.types import Status as MilvusStatus
from pymilvus.exceptions import (
    ConnectError,
    ConnectionNotExistException,
    MilvusUnavailableException,
)

from knowledge_engine.storage.errors import StorageBackendError, StorageUnavailableError


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


# SDK failures that mean the server could not answer this attempt. They are
# safe to surface as retryable; nothing here claims the remote side stopped.
TRANSIENT_RPC_EXCEPTIONS: tuple[type[Exception], ...] = (
    MilvusUnavailableException,
    ConnectionNotExistException,
    ConnectError,
)


# ``grpc.StatusCode.value`` is a ``(number, name)`` tuple, while both
# ``grpc.RpcError.code()`` and the SDK's own status constants are plain
# integers, so every code is normalized to its number before comparison.
def _status_number(status: grpc.StatusCode) -> int:
    value = status.value
    return value[0] if isinstance(value, tuple) else value


TRANSIENT_RPC_STATUS_CODES = frozenset(
    {
        _status_number(grpc.StatusCode.DEADLINE_EXCEEDED),
        _status_number(grpc.StatusCode.UNAVAILABLE),
        _status_number(grpc.StatusCode.ABORTED),
    }
)
# ``_wait_for_channel_ready`` reports a dead target as a plain MilvusException
# with this SDK status, not as a gRPC code or a typed connection exception.
TRANSIENT_RPC_MILVUS_STATUS_CODES = frozenset({MilvusStatus.CONNECT_FAILED})


def rpc_status_code(error: BaseException) -> int | None:
    """Extract the numeric gRPC status code from a PyMilvus or gRPC failure.

    A ``MilvusException`` does not always hold a code: when the SDK's retry loop
    runs out it passes ``grpc.RpcError.code`` - the bound method itself - as the
    code, so the value has to be called instead of compared. Anything that
    cannot be resolved stays ``None`` and is therefore never called retryable.

    The result is the plain integer because ``grpc.RpcError.code()`` returns an
    ``int``, while an explicit code may be the ``grpc.StatusCode`` enum. Both
    carry the same number, and the number is what the SDK transmits.
    """
    code = getattr(error, "code", None)
    if code is None:
        return None
    if callable(code):
        try:
            code = code()
        except Exception:
            return None
    if isinstance(code, grpc.StatusCode):
        return _status_number(code)
    return code if isinstance(code, int) else None


def is_transient_rpc_failure(error: BaseException) -> bool:
    """Whether the server could not answer, so the same attempt may be retried.

    This classifies the failure only. A bounded RPC that timed out says nothing
    about what the server did with the request, so callers must never report it
    as cancelled, rolled back or unwritten.
    """
    if isinstance(error, TRANSIENT_RPC_EXCEPTIONS):
        return True
    status_code = rpc_status_code(error)
    if status_code in TRANSIENT_RPC_STATUS_CODES:
        return True
    code = getattr(error, "code", None)
    return not callable(code) and code in TRANSIENT_RPC_MILVUS_STATUS_CODES


def rpc_failure(error: BaseException) -> StorageBackendError:
    """Turn one SDK RPC failure into a stable storage error.

    The message is intentionally generic: the raw SDK message can carry the
    connection target. The classification is carried by ``retryable`` and the
    SDK code, and the original exception stays as the error's cause.
    """
    status_code = rpc_status_code(error)
    details = {
        "operation_failed": True,
        "sdk_code": "" if status_code is None else str(status_code),
        "sdk_error": type(error).__name__,
    }
    if is_transient_rpc_failure(error):
        return StorageUnavailableError("milvus", details=details)
    return StorageBackendError(
        "Milvus could not complete this operation.",
        details=details,
    )
