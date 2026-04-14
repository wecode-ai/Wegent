# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Issue scoped object storage URL grants."""

from dataclasses import dataclass
from datetime import datetime
from pathlib import PurePosixPath

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import AuthContext
from app.models.task import TaskResource
from app.services.auth import verify_skill_identity_token
from app.services.object_storage import object_storage_presign_service


class ObjectStorageGrantError(Exception):
    """Base class for object storage grant errors."""


class InvalidSkillIdentityError(ObjectStorageGrantError):
    """Raised when the skill identity token is invalid."""


class ObjectStoragePermissionError(ObjectStorageGrantError):
    """Raised when the caller is not allowed to access the storage scope."""


class InvalidObjectNameError(ObjectStorageGrantError):
    """Raised when the requested object name is unsafe."""


class TaskScopeNotFoundError(ObjectStorageGrantError):
    """Raised when the requested task does not exist or is not accessible."""


@dataclass
class ObjectStorageUploadGrant:
    """Presigned upload grant for one object."""

    upload_url: str
    object_key: str
    expires_at: datetime


@dataclass
class ObjectStorageDownloadGrant:
    """Presigned download grant for one object."""

    download_url: str
    object_key: str
    expires_at: datetime


class ObjectStorageUploadGrantService:
    """Validate task scope and mint scoped object storage URLs."""

    def create_upload_grant(
        self,
        *,
        db: Session,
        auth_context: AuthContext,
        skill_identity_token: str,
        task_id: int,
        object_name: str,
    ) -> ObjectStorageUploadGrant:
        object_key = self._resolve_object_key(
            db=db,
            auth_context=auth_context,
            skill_identity_token=skill_identity_token,
            task_id=task_id,
            object_name=object_name,
        )
        upload_url, expires_at = object_storage_presign_service.generate_upload_url(
            bucket=settings.WORKSPACE_ARCHIVE_BUCKET,
            object_key=object_key,
            expires_seconds=settings.PUBLISH_PRESIGNED_UPLOAD_EXPIRE_SECONDS,
        )
        return ObjectStorageUploadGrant(
            upload_url=upload_url,
            object_key=object_key,
            expires_at=expires_at,
        )

    def create_download_grant(
        self,
        *,
        db: Session,
        auth_context: AuthContext,
        skill_identity_token: str,
        task_id: int,
        object_name: str,
    ) -> ObjectStorageDownloadGrant:
        object_key = self._resolve_object_key(
            db=db,
            auth_context=auth_context,
            skill_identity_token=skill_identity_token,
            task_id=task_id,
            object_name=object_name,
        )
        download_url, expires_at = object_storage_presign_service.generate_download_url(
            bucket=settings.WORKSPACE_ARCHIVE_BUCKET,
            object_key=object_key,
            expires_seconds=settings.PUBLISH_PRESIGNED_UPLOAD_EXPIRE_SECONDS,
        )
        return ObjectStorageDownloadGrant(
            download_url=download_url,
            object_key=object_key,
            expires_at=expires_at,
        )

    @staticmethod
    def generate_publish_object_key(
        *, user_name: str, task_id: int, object_name: str
    ) -> str:
        """Build the canonical publish object key."""
        safe_name = PurePosixPath(object_name).name
        return f"publish/{user_name}/{task_id}/{safe_name}"

    @staticmethod
    def _validate_object_name(object_name: str) -> str:
        candidate = object_name.strip()
        if not candidate:
            raise InvalidObjectNameError("Object name is required")
        if "\\" in candidate:
            raise InvalidObjectNameError("Object name must not contain path separators")

        normalized = PurePosixPath(candidate).name
        if normalized != candidate or candidate in {".", ".."}:
            raise InvalidObjectNameError("Object name must be a single file name")

        return normalized

    def _resolve_object_key(
        self,
        *,
        db: Session,
        auth_context: AuthContext,
        skill_identity_token: str,
        task_id: int,
        object_name: str,
    ) -> str:
        self._validate_skill_identity(
            auth_context=auth_context,
            skill_identity_token=skill_identity_token,
        )
        safe_object_name = self._validate_object_name(object_name)
        self._require_task_scope(db=db, auth_context=auth_context, task_id=task_id)
        return self.generate_publish_object_key(
            user_name=auth_context.user.user_name,
            task_id=task_id,
            object_name=safe_object_name,
        )

    @staticmethod
    def _validate_skill_identity(
        *,
        auth_context: AuthContext,
        skill_identity_token: str,
    ) -> None:
        token_info = verify_skill_identity_token(skill_identity_token)
        if token_info is None:
            raise InvalidSkillIdentityError("Invalid skill identity token")

        if (
            token_info.user_id != auth_context.user.id
            or token_info.user_name != auth_context.user.user_name
        ):
            raise ObjectStoragePermissionError(
                "Skill identity token does not match the authenticated user"
            )

    @staticmethod
    def _require_task_scope(
        *,
        db: Session,
        auth_context: AuthContext,
        task_id: int,
    ) -> None:
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.user_id == auth_context.user.id,
                TaskResource.is_active.in_(TaskResource.is_active_query()),
            )
            .first()
        )
        if task is None:
            raise TaskScopeNotFoundError("Task not found")


object_storage_upload_grant_service = ObjectStorageUploadGrantService()
