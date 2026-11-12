"""Protocol tests for real SDK simple/multipart dispatch with synthetic S3 replies."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from minio import Minio
from minio.error import S3Error

from app.services.delivery.conditional_copy import (
    _CREATE_ONLY_TARGET,
    ConditionalCopyMinio,
)


@pytest.mark.parametrize("source_size", [0, 20, 5 * 1024**3 + 1])
def test_destination_condition_covers_simple_and_multipart_commit(
    monkeypatch, source_size
):
    requests = []

    def execute(self, method, bucket_name, object_name, **kwargs):
        query = kwargs.get("query_params") or {}
        requests.append((method, query, dict(kwargs.get("headers") or {})))
        if method == "HEAD":
            return SimpleNamespace(
                headers={
                    "content-length": str(source_size),
                    "etag": '"source-etag"',
                    "last-modified": "Mon, 02 Nov 2026 00:00:00 GMT",
                }
            )
        if method == "POST" and "uploads" in query:
            body = (
                "<InitiateMultipartUploadResult><UploadId>upload</UploadId>"
                "</InitiateMultipartUploadResult>"
            )
        elif method == "POST" and "uploadId" in query:
            body = (
                "<CompleteMultipartUploadResult><Location>test</Location>"
                "<Bucket>test</Bucket><Key>target</Key><ETag>final</ETag>"
                "</CompleteMultipartUploadResult>"
            )
        elif method == "PUT":
            body = (
                "<CopyObjectResult><ETag>copied-etag</ETag>"
                "<LastModified>2026-11-02T00:00:00.000Z</LastModified>"
                "</CopyObjectResult>"
            )
        else:
            raise AssertionError((method, query))
        return SimpleNamespace(data=body.encode(), headers={})

    monkeypatch.setattr(Minio, "_execute", execute)
    client = ConditionalCopyMinio("localhost:9000", region="us-east-1")
    assert client.copy_object_if_absent("test", "source", "target") is True
    commits = [
        headers
        for method, query, headers in requests
        if (method == "PUT" and "uploadId" not in query)
        or (method == "POST" and "uploadId" in query)
    ]
    assert len(commits) == 1
    assert commits[0]["If-None-Match"] == "*"
    assert all(
        "If-None-Match" not in headers
        for method, query, headers in requests
        if method == "HEAD" or (method == "PUT" and "uploadId" in query)
    )


def test_copy_conflict_resets_conditional_context(monkeypatch):
    observations = []

    def execute(self, method, bucket_name, object_name, **kwargs):
        headers = kwargs.get("headers") or {}
        observations.append(headers.get("If-None-Match"))
        raise S3Error(None, "PreconditionFailed", "Exists", "/target", "id", "host")

    monkeypatch.setattr(Minio, "_execute", execute)
    client = ConditionalCopyMinio("localhost:9000", region="us-east-1")
    # The SDK stats the source before copying. Focus this protocol case on the
    # write and use the other cases above to exercise the real stat/compose path.
    monkeypatch.setattr(
        client,
        "stat_object",
        lambda *args, **kwargs: SimpleNamespace(size=0, metadata={}),
    )
    assert client.copy_object_if_absent("test", "source", "target") is False
    from minio.commonconfig import CopySource

    with pytest.raises(S3Error):
        client.copy_object("test", "target", CopySource("test", "source"))
    assert observations == ["*", None]


@pytest.mark.parametrize(
    ("method", "object_name", "body", "query", "scope", "code", "retire"),
    [
        (
            "POST",
            "target",
            b"xml",
            {"uploadId": "upload"},
            True,
            "PreconditionFailed",
            True,
        ),
        ("PUT", "target", b"", None, True, "PreconditionFailed", True),
        ("HEAD", "source", None, None, True, "PreconditionFailed", False),
        ("PUT", "other", b"", None, True, "PreconditionFailed", False),
        ("PUT", "target", b"", None, False, "PreconditionFailed", False),
        (
            "DELETE",
            "target",
            None,
            {"uploadId": "upload"},
            True,
            "PreconditionFailed",
            False,
        ),
        ("PUT", "target", b"", None, True, "AccessDenied", False),
    ],
)
def test_only_create_only_destination_conflicts_retire_the_pool_and_reraise(
    monkeypatch, method, object_name, body, query, scope, code, retire
):
    error = S3Error(None, code, "Rejected", "/synthetic", "id", "host")
    execute = Mock(side_effect=error)
    monkeypatch.setattr(Minio, "_execute", execute)
    client = ConditionalCopyMinio("localhost:9000", region="us-east-1")
    clear = Mock()
    monkeypatch.setattr(client._http, "clear", clear)
    token = _CREATE_ONLY_TARGET.set(("test", "target") if scope else None)
    try:
        with pytest.raises(S3Error) as raised:
            client._execute(method, "test", object_name, body=body, query_params=query)
        assert raised.value is error
        execute.assert_called_once()
        assert clear.call_count == int(retire)
    finally:
        _CREATE_ONLY_TARGET.reset(token)


@pytest.mark.parametrize(
    ("source_size", "abort_fails"), [(0, False), (20, False), (20, True)]
)
def test_real_sdk_conflict_retires_connections_before_required_abort(
    monkeypatch, source_size, abort_fails
):
    events = []
    abort_error = ConnectionResetError("Synthetic abort transport failure")
    client = ConditionalCopyMinio("localhost:9000", region="us-east-1")
    monkeypatch.setattr(client._http, "clear", lambda: events.append("retire"))
    monkeypatch.setattr(
        client,
        "stat_object",
        lambda *args, **kwargs: SimpleNamespace(
            size=source_size, metadata={}, etag="source-etag"
        ),
    )

    def execute(self, method, bucket_name, object_name, **kwargs):
        query = kwargs.get("query_params") or {}
        commit = (method == "PUT" and not query) or (
            method == "POST" and "uploadId" in query
        )
        headers = kwargs.get("headers") or {}
        assert headers.get("If-None-Match") == ("*" if commit else None)
        if commit:
            events.append("conflict")
            raise S3Error(None, "PreconditionFailed", "Exists", "/target", "id", "host")
        if method == "DELETE":
            assert events == ["conflict", "retire"]
            events.append("abort")
            if abort_fails:
                raise abort_error
            return SimpleNamespace(data=b"", headers={})
        if method == "POST" and "uploads" in query:
            body = "<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>"
        elif method == "PUT" and "uploadId" in query:
            body = "<CopyObjectResult><ETag>copied</ETag><LastModified>2026-11-02T00:00:00.000Z</LastModified></CopyObjectResult>"
        else:
            raise AssertionError((method, query))
        return SimpleNamespace(data=body.encode(), headers={})

    monkeypatch.setattr(Minio, "_execute", execute)
    if abort_fails:
        with pytest.raises(ConnectionResetError) as raised:
            client.copy_object_if_absent("test", "source", "target")
        assert raised.value is abort_error
    else:
        assert client.copy_object_if_absent("test", "source", "target") is False
    assert events == ["conflict", "retire"] + (["abort"] if source_size else [])
    assert _CREATE_ONLY_TARGET.get() is None
