# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Conservative SDK error classification at the external cleanup boundary."""

from collections.abc import Iterator
from contextlib import contextmanager

from shared.knowledge_cleanup import ExternalEngineCleanupError


@contextmanager
def external_cleanup_boundary(storage_type: str) -> Iterator[None]:
    """Normalize only explicit SDK failures from a resolved storage operation."""
    try:
        yield
    except Exception as error:
        classified = classify_cleanup_error(storage_type, error)
        if classified is not None:
            raise classified from error
        raise


def classify_cleanup_error(
    storage_type: str, error: Exception
) -> ExternalEngineCleanupError | None:
    """Unknown SDK errors and local configuration failures never permit deletion."""
    reason = None
    if storage_type == "qdrant":
        reason = _qdrant_reason(error)
    elif storage_type == "elasticsearch":
        reason = _elasticsearch_reason(error)
    elif storage_type == "milvus":
        reason = _milvus_reason(error)
    return ExternalEngineCleanupError(storage_type, reason) if reason else None


def _qdrant_reason(error: Exception) -> str | None:
    import ssl

    import httpx
    from qdrant_client.http.exceptions import (
        ResponseHandlingException,
        UnexpectedResponse,
    )

    if isinstance(error, UnexpectedResponse) and error.status_code in {401, 403}:
        return "authentication_failed"
    if isinstance(error, ResponseHandlingException):
        cause: BaseException | None = error.source
        seen: set[int] = set()
        while cause is not None and id(cause) not in seen:
            seen.add(id(cause))
            if isinstance(cause, ssl.SSLError):
                return None
            cause = cause.__cause__
        if isinstance(error.source, httpx.TimeoutException):
            return "timeout"
        if isinstance(
            error.source, (httpx.ConnectError, httpx.ReadError, httpx.WriteError)
        ):
            return "connection_failed"
    return None


def _elasticsearch_reason(error: Exception) -> str | None:
    from elastic_transport import ConnectionError, ConnectionTimeout, TlsError
    from elasticsearch import AuthenticationException, AuthorizationException

    if isinstance(error, (AuthenticationException, AuthorizationException)):
        return "authentication_failed"
    if isinstance(error, ConnectionTimeout):
        return "timeout"
    if isinstance(error, ConnectionError) and not isinstance(error, TlsError):
        return "connection_failed"
    return None


def _milvus_reason(error: Exception) -> str | None:
    import grpc
    from pymilvus.exceptions import ConnectError, MilvusUnavailableException

    reason = None
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (ConnectError, MilvusUnavailableException)):
            reason = "connection_failed"
        if isinstance(current, grpc.RpcError):
            return {
                grpc.StatusCode.UNAVAILABLE: "connection_failed",
                grpc.StatusCode.DEADLINE_EXCEEDED: "timeout",
                grpc.StatusCode.UNAUTHENTICATED: "authentication_failed",
                grpc.StatusCode.PERMISSION_DENIED: "authentication_failed",
            }.get(current.code())
        current = current.__cause__
    return reason
