# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import hashlib
import hmac
import json
import time
import uuid

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject
from app.models.user import User
from app.schemas.project_workflow import (
    ExecutionTargetRef,
    ProjectWorkflowAutomationCreate,
    RepositoryBindingCreate,
    WorkflowDefinitionCreate,
)
from app.services.project_workflows import project_workflow_service


def _project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"WH{uuid.uuid4().hex[:8].upper()}",
        name="Webhook project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def test_github_webhook_verifies_signature_timestamp_and_delivery_id(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    repository = project_workflow_service.create_repository(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=RepositoryBindingCreate(
            provider="github",
            repository_identity="wegent/webhook",
            repository_url="https://github.com/wegent/webhook.git",
        ),
    )
    rotated = project_workflow_service.rotate_repository_webhook_secret(
        test_db,
        project_id=project.id,
        binding_id=repository.id,
        user_id=test_user.id,
    )
    body = json.dumps(
        {
            "action": "completed",
            "check_run": {
                "id": 17,
                "name": "unit-tests",
                "status": "completed",
                "conclusion": "success",
                "check_suite": {"head_branch": "feature/no-match"},
            },
        },
        separators=(",", ":"),
    ).encode()
    timestamp = str(int(time.time()))
    signature = hmac.new(
        rotated.secret.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()
    headers = {
        "X-Wegent-Repository-Binding": repository.id,
        "X-Wegent-Timestamp": timestamp,
        "X-Hub-Signature-256": f"sha256={signature}",
        "X-GitHub-Delivery": "delivery-17",
        "X-GitHub-Event": "check_run",
        "Content-Type": "application/json",
    }

    invalid = test_client.post(
        "/api/v1/repository-integrations/github/webhook",
        headers={**headers, "X-Hub-Signature-256": "sha256=invalid"},
        content=body,
    )
    accepted = test_client.post(
        "/api/v1/repository-integrations/github/webhook",
        headers=headers,
        content=body,
    )
    duplicate = test_client.post(
        "/api/v1/repository-integrations/github/webhook",
        headers=headers,
        content=body,
    )

    assert invalid.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["processingStatus"] == "unmatched"
    assert duplicate.status_code == 200
    assert duplicate.json()["duplicate"] is True


def test_workflow_automation_webhook_creates_one_task_per_delivery(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    workflow = project_workflow_service.create_workflow(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=WorkflowDefinitionCreate.model_validate(
            {
                "name": "Webhook delivery",
                "triggerMode": "automatic",
                "stages": [
                    {
                        "key": "complete",
                        "name": "Complete",
                        "nodes": [
                            {
                                "key": "done",
                                "name": "Done",
                                "type": "complete",
                            }
                        ],
                    }
                ],
            }
        ),
    )
    automation = project_workflow_service.create_automation(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=ProjectWorkflowAutomationCreate(
            name="Incoming issue",
            trigger_type="webhook",
            workflow_id=workflow.id,
            execution_target=ExecutionTargetRef(type="managed_container"),
            task_template={"title": "Webhook-created task"},
        ),
    )
    secret = project_workflow_service.rotate_automation_webhook_secret(
        test_db,
        project_id=project.id,
        automation_id=automation.id,
        user_id=test_user.id,
    )
    body = json.dumps(
        {"issue": {"title": "Webhook task"}}, separators=(",", ":")
    ).encode()
    timestamp = str(int(time.time()))
    signature = hmac.new(
        secret.webhook_secret.encode(),
        timestamp.encode() + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    headers = {
        "X-Wegent-Timestamp": timestamp,
        "X-Wegent-Signature": f"sha256={signature}",
        "X-Wegent-Delivery": "workflow-delivery-1",
        "Content-Type": "application/json",
    }
    path = (
        f"/api/v1/repository-integrations/workflow-automations/"
        f"{secret.webhook_token}/webhook"
    )

    accepted = test_client.post(path, headers=headers, content=body)
    duplicate = test_client.post(path, headers=headers, content=body)

    assert accepted.status_code == 200
    assert accepted.json()["status"] == "succeeded"
    assert accepted.json()["loopItemId"]
    assert duplicate.status_code == 200
    assert duplicate.json()["id"] == accepted.json()["id"]
