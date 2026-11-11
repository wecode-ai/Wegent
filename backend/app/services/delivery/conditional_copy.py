"""S3 destination preconditions for the installed MinIO SDK's copy paths."""

from contextvars import ContextVar
from typing import Any

from minio import Minio
from minio.commonconfig import ComposeSource
from minio.error import S3Error

_CREATE_ONLY_TARGET: ContextVar[tuple[str, str] | None] = ContextVar(
    "delivery_create_only_target", default=None
)


class ConditionalCopyMinio(Minio):
    def copy_object_if_absent(self, bucket: str, source: str, target: str) -> bool:
        token = _CREATE_ONLY_TARGET.set((bucket, target))
        try:
            stat = self.stat_object(bucket, source)
            metadata = {
                key: value
                for key, value in stat.metadata.items()
                if key.lower().startswith("x-amz-meta-")
                or key.lower()
                in {
                    "content-type",
                    "content-disposition",
                    "content-encoding",
                    "content-language",
                    "cache-control",
                }
            }
            if stat.size == 0:
                self._put_object(bucket, target, b"", headers=metadata)
            else:
                self.compose_object(
                    bucket,
                    target,
                    [ComposeSource(bucket, source, offset=0, length=stat.size)],
                    metadata=metadata,
                )
            return True
        except S3Error as exc:
            if exc.code == "PreconditionFailed":
                return False
            raise
        finally:
            _CREATE_ONLY_TARGET.reset(token)

    def _execute(
        self,
        method: str,
        bucket_name: str | None = None,
        object_name: str | None = None,
        body: bytes | None = None,
        headers: dict[str, Any] | None = None,
        query_params: dict[str, Any] | None = None,
        preload_content: bool = True,
        no_body_trace: bool = False,
    ) -> Any:
        # CopyObject ignores destination conditions on supported legacy MinIO.
        # Commit a server-side multipart copy conditionally; empty objects use
        # conditional PutObject. Neither path publishes an unconditional write.
        # https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
        query = query_params or {}
        destination_write = (method == "PUT" and body is not None and not query) or (
            method == "POST" and "uploadId" in query
        )
        if (
            _CREATE_ONLY_TARGET.get() == (bucket_name, object_name)
            and destination_write
        ):
            headers = {**(headers or {}), "If-None-Match": "*"}
        return super()._execute(
            method,
            bucket_name,
            object_name,
            body=body,
            headers=headers,
            query_params=query_params,
            preload_content=preload_content,
            no_body_trace=no_body_trace,
        )
