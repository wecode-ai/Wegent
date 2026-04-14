# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal object storage API endpoints."""

import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.task import TaskResource
from app.models.user import User
from app.services.auth import create_skill_identity_token
from app.services.object_storage import object_storage_presign_service


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


def _load_object_storage_router():
    module_path = (
        Path(__file__).resolve().parents[4]
        / "app/api/endpoints/internal/object_storage.py"
    )
    spec = importlib.util.spec_from_file_location(
        "object_storage_endpoint_test_module", module_path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.router


@pytest.fixture
def object_storage_test_client(test_db: Session) -> TestClient:
    app = FastAPI()
    app.include_router(_load_object_storage_router(), prefix="/api/internal")

    def override_get_db():
        try:
            yield test_db
        except Exception:
            test_db.rollback()
            raise

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app)


def test_object_storage_upload_url_requires_developer_token(
    object_storage_test_client: TestClient,
    test_user: User,
):
    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="executor-1",
    )

    response = object_storage_test_client.post(
        "/api/internal/object-storage/upload-url",
        json={
            "task_id": 1,
            "object_name": "demo.zip",
            "skill_identity_token": token,
        },
    )

    assert response.status_code == 401


def test_object_storage_upload_url_returns_presigned_upload(
    object_storage_test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key,
    mocker,
):
    task = _create_task(test_db, task_id=9753, user_id=test_user.id)
    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="executor-1",
    )
    raw_api_key, _ = test_api_key
    expires_at = datetime(2026, 4, 10, 8, 0, tzinfo=timezone.utc)
    mocker.patch.object(
        object_storage_presign_service,
        "generate_upload_url",
        return_value=("https://minio.example.com/upload", expires_at),
    )

    response = object_storage_test_client.post(
        "/api/internal/object-storage/upload-url",
        headers={"X-API-Key": raw_api_key},
        json={
            "task_id": task.id,
            "object_name": "demo.zip",
            "skill_identity_token": token,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "upload_url": "https://minio.example.com/upload",
        "object_key": f"publish/{test_user.user_name}/{task.id}/demo.zip",
        "expires_at": "2026-04-10T08:00:00Z",
    }


def test_object_storage_upload_url_rejects_mismatched_skill_identity(
    object_storage_test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key,
):
    task = _create_task(test_db, task_id=9754, user_id=test_user.id)
    token = create_skill_identity_token(
        user_id=test_user.id + 1,
        user_name="other-user",
        runtime_type="executor",
        runtime_name="executor-1",
    )
    raw_api_key, _ = test_api_key

    response = object_storage_test_client.post(
        "/api/internal/object-storage/upload-url",
        headers={"X-API-Key": raw_api_key},
        json={
            "task_id": task.id,
            "object_name": "demo.zip",
            "skill_identity_token": token,
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == (
        "Skill identity token does not match the authenticated user"
    )


def test_object_storage_download_url_returns_presigned_download(
    object_storage_test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key,
    mocker,
):
    task = _create_task(test_db, task_id=9755, user_id=test_user.id)
    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="executor-1",
    )
    raw_api_key, _ = test_api_key
    expires_at = datetime(2026, 4, 10, 9, 0, tzinfo=timezone.utc)
    mocker.patch.object(
        object_storage_presign_service,
        "generate_download_url",
        return_value=("https://minio.example.com/download", expires_at),
    )

    response = object_storage_test_client.post(
        "/api/internal/object-storage/download-url",
        headers={"X-API-Key": raw_api_key},
        json={
            "task_id": task.id,
            "object_name": "demo.zip",
            "skill_identity_token": token,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "download_url": "https://minio.example.com/download",
        "object_key": f"publish/{test_user.user_name}/{task.id}/demo.zip",
        "expires_at": "2026-04-10T09:00:00Z",
    }
