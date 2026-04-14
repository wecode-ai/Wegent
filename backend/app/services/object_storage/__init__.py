# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Object storage services."""

from app.services.object_storage.presign_service import (
    ObjectStoragePresignService,
    object_storage_presign_service,
)
from app.services.object_storage.upload_grant_service import (
    InvalidObjectNameError,
    InvalidSkillIdentityError,
    ObjectStorageDownloadGrant,
    ObjectStoragePermissionError,
    ObjectStorageUploadGrant,
    TaskScopeNotFoundError,
    object_storage_upload_grant_service,
)

__all__ = [
    "InvalidObjectNameError",
    "InvalidSkillIdentityError",
    "ObjectStorageDownloadGrant",
    "ObjectStoragePermissionError",
    "ObjectStoragePresignService",
    "ObjectStorageUploadGrant",
    "TaskScopeNotFoundError",
    "object_storage_presign_service",
    "object_storage_upload_grant_service",
]
