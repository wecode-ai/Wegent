# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Only proven external SDK failures permit content-only deletion."""

from unittest.mock import MagicMock, patch

import grpc
import httpx
import pytest
from elastic_transport import ApiResponseMeta
from elastic_transport import ConnectionError as ESConnectionError
from elastic_transport import ConnectionTimeout, NodeConfig, TlsError
from elasticsearch import AuthenticationException
from pymilvus import connections
from pymilvus.client.grpc_handler import GrpcHandler
from pymilvus.client.types import Status
from pymilvus.exceptions import (
    ConnectError,
    ConnectionConfigException,
    MilvusException,
    MilvusUnavailableException,
)
from qdrant_client.http.exceptions import ResponseHandlingException, UnexpectedResponse

from knowledge_engine.storage.cleanup_errors import classify_cleanup_error


class RpcFailure(grpc.RpcError):
    def __init__(self, status: grpc.StatusCode) -> None:
        self.status = status

    def code(self) -> grpc.StatusCode:
        return self.status


@pytest.mark.parametrize(
    "provider,error,reason",
    [
        (
            "qdrant",
            ResponseHandlingException(httpx.ConnectError("private")),
            "connection_failed",
        ),
        ("qdrant", ResponseHandlingException(httpx.ReadTimeout("private")), "timeout"),
        (
            "qdrant",
            UnexpectedResponse(401, "private", b"secret", {}),
            "authentication_failed",
        ),
        ("elasticsearch", ESConnectionError("private"), "connection_failed"),
        ("elasticsearch", ConnectionTimeout("private"), "timeout"),
        ("milvus", ConnectError(message="private"), "connection_failed"),
        ("milvus", MilvusUnavailableException(), "connection_failed"),
        ("milvus", RpcFailure(grpc.StatusCode.DEADLINE_EXCEEDED), "timeout"),
        (
            "milvus",
            RpcFailure(grpc.StatusCode.UNAUTHENTICATED),
            "authentication_failed",
        ),
    ],
)
def test_explicit_sdk_failures_have_safe_cleanup_reasons(
    provider: str, error: Exception, reason: str
) -> None:
    result = classify_cleanup_error(provider, error)
    assert result is not None
    assert result.reason == reason
    assert "private" not in str(result)
    assert "secret" not in str(result)


@pytest.mark.parametrize(
    "provider,error",
    [
        ("qdrant", ResponseHandlingException(ValueError("config"))),
        ("qdrant", UnexpectedResponse(500, "unknown", b"", {})),
        ("qdrant", UnexpectedResponse(429, "rate limit", b"", {})),
        ("elasticsearch", TlsError("invalid local certificate")),
        ("milvus", MilvusException(code=1, message="permission denied")),
        (
            "milvus",
            MilvusException(
                code=Status.CONNECT_FAILED, message="No channel configured"
            ),
        ),
        (
            "milvus",
            ConnectionConfigException(code=Status.CONNECT_FAILED, message="bad config"),
        ),
        ("milvus", RpcFailure(grpc.StatusCode.UNKNOWN)),
        ("elasticsearch", RuntimeError("connection failed")),
        ("qdrant", httpx.ConnectError("not emitted by the qdrant SDK wrapper")),
        ("unknown", TimeoutError()),
    ],
)
def test_ambiguous_or_local_failures_cannot_be_continued(
    provider: str, error: Exception
) -> None:
    assert classify_cleanup_error(provider, error) is None


def test_elasticsearch_external_credentials_are_distinct_from_internal_auth() -> None:
    meta = ApiResponseMeta(
        status=401,
        http_version="1.1",
        headers={},
        duration=0,
        node=NodeConfig(scheme="http", host="localhost", port=9200),
    )
    result = classify_cleanup_error(
        "elasticsearch", AuthenticationException("secret", meta, {})
    )
    assert result.reason == "authentication_failed"


def test_milvus_preserves_the_sdk_rpc_cause_without_parsing_error_text() -> None:
    wrapped = MilvusException(code=1, message="opaque wrapper")
    wrapped.__cause__ = RpcFailure(grpc.StatusCode.UNAUTHENTICATED)
    result = classify_cleanup_error("milvus", wrapped)
    assert result is not None
    assert result.reason == "authentication_failed"


@pytest.mark.parametrize("wrapped", [False, True])
def test_milvus_sdk_connection_timeout_survives_its_self_cause(
    wrapped: bool,
) -> None:
    """Execute the installed SDK's connection path without opening a socket."""
    handler = object.__new__(GrpcHandler)
    handler._channel = object()
    handler._user = ""
    handler._address = "synthetic-milvus"
    handler.close = MagicMock()
    readiness = MagicMock()
    readiness.result.side_effect = grpc.FutureTimeoutError()

    with (
        patch("pymilvus.orm.connections.GrpcHandler", return_value=handler),
        patch("grpc.channel_ready_future", return_value=readiness),
        pytest.raises(MilvusException) as caught,
    ):
        connections.connect(
            alias="cleanup-timeout-unit-test",
            uri="http://localhost:19530",
            timeout=0.01,
        )

    error = caught.value
    assert type(error) is MilvusException
    assert error.code == Status.CONNECT_FAILED
    assert error.__cause__ is error
    assert isinstance(error.__context__, grpc.FutureTimeoutError)
    if wrapped:
        outer = MilvusException(code=1, message="opaque SDK wrapper")
        outer.__cause__ = error
        error = outer
    result = classify_cleanup_error("milvus", error)

    assert result is not None
    assert result.reason == "timeout"
