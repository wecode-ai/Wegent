# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private object storage for immutable plugin release packages."""

import io
from datetime import datetime

from minio.error import S3Error

from app.core.config import settings
from app.services.object_storage import object_storage_presign_service


class PluginPackageStorageError(RuntimeError):
    """Raised when the plugin package store cannot complete an operation."""


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
        except (S3Error, ValueError) as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def put(self, object_key: str, package_bytes: bytes) -> None:
        self.ensure_bucket()
        try:
            self.client.put_object(
                self.bucket,
                object_key,
                io.BytesIO(package_bytes),
                len(package_bytes),
                content_type="application/zip",
            )
        except S3Error as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def put_immutable(self, object_key: str, package_bytes: bytes) -> bool:
        """Create an immutable object, or verify an identical existing object."""
        try:
            self.client.stat_object(self.bucket, object_key)
        except S3Error as exc:
            if exc.code not in {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}:
                raise PluginPackageStorageError(str(exc)) from exc
            self.put(object_key, package_bytes)
            return True
        except ValueError as exc:
            raise PluginPackageStorageError(str(exc)) from exc
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
        except (S3Error, ValueError) as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def get(self, object_key: str) -> bytes:
        try:
            response = self.client.get_object(self.bucket, object_key)
            try:
                return response.read()
            finally:
                response.close()
                response.release_conn()
        except (S3Error, ValueError) as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def presign_upload(self, object_key: str) -> tuple[str, datetime]:
        self.ensure_bucket()
        try:
            return object_storage_presign_service.generate_upload_url(
                bucket=self.bucket,
                object_key=object_key,
                expires_seconds=settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS,
            )
        except (S3Error, ValueError) as exc:
            raise PluginPackageStorageError(str(exc)) from exc

    def presign_download(self, object_key: str) -> tuple[str, datetime]:
        try:
            return object_storage_presign_service.generate_download_url(
                bucket=self.bucket,
                object_key=object_key,
                expires_seconds=settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS,
            )
        except (S3Error, ValueError) as exc:
            raise PluginPackageStorageError(str(exc)) from exc


plugin_package_storage = PluginPackageStorage()
