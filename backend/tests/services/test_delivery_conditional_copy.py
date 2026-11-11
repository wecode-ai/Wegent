"""Protocol tests for real SDK simple/multipart dispatch with synthetic S3 replies."""

from types import SimpleNamespace

import pytest
from minio import Minio
from minio.error import S3Error

from app.services.delivery.conditional_copy import ConditionalCopyMinio


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
