# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage services package."""

from app.services.storage.minio_client import minio_client, MinioClient

__all__ = ["minio_client", "MinioClient"]
