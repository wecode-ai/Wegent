# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for object storage upload grant service."""

from datetime import datetime, timezone

import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import AuthContext
from app.models.task import TaskResource
from app.models.user import User
from app.services.auth import create_skill_identity_token
from app.services.object_storage import (
    InvalidObjectNameError,
    InvalidSkillIdentityError,
    ObjectStoragePermissionError,
    TaskScopeNotFoundError,
    object_storage_presign_service,
    object_storage_upload_grant_service,
)


def _create_task(test_db: Session, task_id: int, user_id: int) -> TaskResource:
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {},
            "status": {},
        },
        is_active=TaskResource.STATE_ACTIVE,
        project_id=0,
        is_group_chat=False,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    return task


def test_create_upload_grant_returns_presigned_upload(
    test_db: Session,
    test_user: User,
    mocker,
):
    _create_task(test_db, task_id=2468, user_id=test_user.id)
    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="executor-1",
    )
    expires_at = datetime(2026, 4, 10, 8, 0, tzinfo=timezone.utc)
    generate_upload_url = mocker.patch.object(
        object_storage_presign_service,
        "generate_upload_url",
        return_value=("https://minio.example.com/upload", expires_at),
    )

    grant = object_storage_upload_grant_service.create_upload_grant(
        db=test_db,
        auth_context=AuthContext(user=test_user),
        skill_identity_token=token,
        task_id=2468,
        object_name="demo.zip",
    )

    assert grant.upload_url == "https://minio.example.com/upload"
    assert grant.object_key == "publish/testuser/2468/demo.zip"
    assert grant.expires_at == expires_at
    assert (
        generate_upload_url.call_args.kwargs["bucket"]
        == settings.WORKSPACE_ARCHIVE_BUCKET
    )


def test_create_download_grant_returns_presigned_download(
    test_db: Session,
    test_user: User,
    mocker,
):
    _create_task(test_db, task_id=2469, user_id=test_user.id)
    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="executor-1",
    )
    expires_at = datetime(2026, 4, 10, 9, 0, tzinfo=timezone.utc)
    generate_download_url = mocker.patch.object(
        object_storage_presign_service,
        "generate_download_url",
        return_value=("https://minio.example.com/download", expires_at),
    )

    grant = object_storage_upload_grant_service.create_download_grant(
        db=test_db,
        auth_context=AuthContext(user=test_user),
        skill_identity_token=token,
        task_id=2469,
        object_name="demo.zip",
    )

    assert grant.download_url == "https://minio.example.com/download"
    assert grant.object_key == "publish/testuser/2469/demo.zip"
    assert grant.expires_at == expires_at
    assert (
        generate_download_url.call_args.kwargs["bucket"]
        == settings.WORKSPACE_ARCHIVE_BUCKET
    )


def test_create_upload_grant_rejects_invalid_skill_identity(
    test_db: Session,
    test_user: User,
):
    with pytest.raises(InvalidSkillIdentityError):
        object_storage_upload_grant_service.create_upload_grant(
            db=test_db,
            auth_context=AuthContext(user=test_user),
            skill_identity_token="invalid-token",
            task_id=2468,
            object_name="demo.zip",
        )


def test_create_upload_grant_rejects_mismatched_identity(
    test_db: Session,
    test_user: User,
):
    token = create_skill_identity_token(
        user_id=test_user.id + 1,
        user_name="other-user",
        runtime_type="executor",
        runtime_name="executor-1",
    )

    with pytest.raises(ObjectStoragePermissionError):
        object_storage_upload_grant_service.create_upload_grant(
            db=test_db,
            auth_context=AuthContext(user=test_user),
            skill_identity_token=token,
            task_id=2468,
            object_name="demo.zip",
        )


def test_create_upload_grant_rejects_invalid_object_name(
    test_db: Session,
    test_user: User,
):
    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="executor-1",
    )

    with pytest.raises(InvalidObjectNameError):
        object_storage_upload_grant_service.create_upload_grant(
            db=test_db,
            auth_context=AuthContext(user=test_user),
            skill_identity_token=token,
            task_id=2468,
            object_name="nested/demo.zip",
        )


def test_create_upload_grant_rejects_missing_task(
    test_db: Session,
    test_user: User,
):
    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="executor-1",
    )

    with pytest.raises(TaskScopeNotFoundError):
        object_storage_upload_grant_service.create_upload_grant(
            db=test_db,
            auth_context=AuthContext(user=test_user),
            skill_identity_token=token,
            task_id=9999,
            object_name="demo.zip",
        )
