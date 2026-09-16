# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Classification of PyMilvus RPC failures into stable storage errors.

Keeping this separate from the Milvus adapter's request lifecycle keeps the
one question that matters here - could the server answer this attempt? - out
of the code that owns schema, filters and client lifetimes.
"""

from __future__ import annotations

import grpc
from pymilvus.client.types import Status as MilvusStatus
from pymilvus.exceptions import (
    ConnectError,
    ConnectionNotExistException,
    MilvusException,
    MilvusUnavailableException,
)

from knowledge_engine.storage.errors import (
    StorageBackendError,
    StorageUnavailableError,
)

# SDK failures that mean the server could not answer this attempt. They are
# safe to surface as retryable; nothing here claims the remote side stopped.
TRANSIENT_RPC_EXCEPTIONS: tuple[type[Exception], ...] = (
    MilvusUnavailableException,
    ConnectionNotExistException,
    ConnectError,
)
TRANSIENT_RPC_STATUS_CODES = frozenset(
    {
        grpc.StatusCode.DEADLINE_EXCEEDED,
        grpc.StatusCode.UNAVAILABLE,
        grpc.StatusCode.ABORTED,
    }
)
# ``_wait_for_channel_ready`` reports a dead target as a plain MilvusException
# with this SDK status, not as a gRPC code or a typed connection exception.
TRANSIENT_RPC_MILVUS_STATUS_CODES = frozenset({MilvusStatus.CONNECT_FAILED})


def is_transient_rpc_failure(error: MilvusException) -> bool:
    """Whether the server could not answer, so the same attempt may be retried.

    This classifies the failure only. A bounded RPC that timed out says nothing
    about what the server did with the request, so callers must never report it
    as cancelled, rolled back or unwritten.
    """
    if isinstance(error, TRANSIENT_RPC_EXCEPTIONS):
        return True
    return (
        error.code in TRANSIENT_RPC_STATUS_CODES
        or error.code in TRANSIENT_RPC_MILVUS_STATUS_CODES
    )


def rpc_failure(error: MilvusException) -> StorageBackendError:
    """Turn one SDK RPC failure into a stable storage error.

    The message is intentionally generic: the raw SDK message can carry the
    connection target. The classification is carried by ``retryable`` and the
    SDK code, and the original exception stays as the error's cause.
    """
    details = {
        "operation_failed": True,
        "sdk_code": str(error.code),
        "sdk_error": type(error).__name__,
    }
    if is_transient_rpc_failure(error):
        return StorageUnavailableError("milvus", details=details)
    return StorageBackendError(
        "Milvus could not complete this operation.",
        details=details,
    )
