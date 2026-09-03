# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private object storage for immutable plugin release packages."""

import io
from collections.abc import Iterator
from datetime import datetime

from minio.error import S3Error
from urllib3.exceptions import HTTPError

from app.core.config import settings
from app.services.object_storage import object_storage_presign_service


class PluginPackageStorageError(RuntimeError):
    """Raised when the plugin package store cannot complete an operation."""


_STORAGE_ERRORS = (S3Error, HTTPError, OSError, ValueError)


class PluginPackageStorage:
    """Store plugin packages in the configured S3-compatible object store."""

    @property
    def bucket(self) -> str:
        return settings.PLUGIN_STORAGE_BUCKET

    @property
    def client(self):
        return object_storage_presign_service.client

    def ensure_bucket(self) -> None:
        try:
            if not self.client.bucket_exists(self.bucket):
                self.client.make_bucket(self.bucket)
        except _STORAGE_ERRORS as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def put(
        self,
        object_key: str,
        package_bytes: bytes,
        *,
        content_type: str = "application/zip",
    ) -> None:
        self.ensure_bucket()
        try:
            self.client.put_object(
                self.bucket,
                object_key,
                io.BytesIO(package_bytes),
                len(package_bytes),
                content_type=content_type,
            )
        except _STORAGE_ERRORS as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def put_immutable(
        self,
        object_key: str,
        package_bytes: bytes,
        *,
        content_type: str = "application/zip",
    ) -> bool:
        """Create an immutable object, or verify an identical existing object."""
        try:
            self.client.stat_object(self.bucket, object_key)
        except _STORAGE_ERRORS as exc:
            if not isinstance(exc, S3Error) or exc.code not in {
                "NoSuchKey",
                "NoSuchObject",
                "NoSuchBucket",
            }:
                raise PluginPackageStorageError(str(exc)) from exc
            self.put(object_key, package_bytes, content_type=content_type)
            return True
        else:
            existing = self.get(object_key)
            if existing != package_bytes:
                raise PluginPackageStorageError(
                    "Immutable plugin object already exists with different content: "
                    f"{object_key}"
                )
            return False

    def delete(self, object_key: str) -> None:
        """Delete a staging or rolled-back object."""
        try:
            self.client.remove_object(self.bucket, object_key)
        except _STORAGE_ERRORS as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def get(self, object_key: str) -> bytes:
        try:
            response = self.client.get_object(self.bucket, object_key)
            try:
                return response.read()
            finally:
                response.close()
                response.release_conn()
        except _STORAGE_ERRORS as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def open_download(
        self, object_key: str, *, chunk_size: int = 64 * 1024
    ) -> Iterator[bytes]:
        """Open an object and stream it without buffering the package in Backend."""
        try:
            response = self.client.get_object(self.bucket, object_key)
        except _STORAGE_ERRORS as exc:
            raise PluginPackageStorageError(str(exc)) from exc

        def chunks() -> Iterator[bytes]:
            try:
                while chunk := response.read(chunk_size):
                    yield chunk
            except _STORAGE_ERRORS as exc:
                raise PluginPackageStorageError(str(exc)) from exc
            finally:
                response.close()
                response.release_conn()

        return chunks()

    def presign_download(self, object_key: str) -> tuple[str, datetime]:
        try:
            return object_storage_presign_service.generate_download_url(
                bucket=self.bucket,
                object_key=object_key,
                expires_seconds=settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS,
            )
        except _STORAGE_ERRORS as exc:
            raise PluginPackageStorageError(str(exc)) from exc


plugin_package_storage = PluginPackageStorage()
