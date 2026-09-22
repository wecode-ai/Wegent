# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project agent environment grants use the same identity as the environment API."""

from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.project_chat.service import require_project_execution_environment
from app.services.workspaces.resource_mapping import execution_environment_values


@pytest.fixture
def granted_device(test_db: Session, test_user: User) -> tuple[Kind, ResourceMember]:
    device = Kind(
        kind="Device",
        name="desktop-installation",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {"deviceType": "app", "deviceId": "shared-logical-id"}},
    )
    test_db.add(device)
    test_db.flush()
    grant = ResourceMember(
        resource_type=ResourceType.DEVICE.value,
        resource_id=device.id,
        entity_type="project",
        entity_id="123",
        role=BaseRole.Developer.value,
        status=MemberStatus.APPROVED.value,
    )
    test_db.add(grant)
    test_db.commit()
    return device, grant


@pytest.mark.parametrize(
    "spec",
    [
        {"deviceType": "app", "deviceId": "shared-logical-id"},
        {"deviceType": "cloud", "deviceId": "cloud-runtime"},
        {"deviceType": "cloud", "cloudConfig": {"deviceId": "cloud-runtime"}},
        {"deviceType": "local"},
    ],
)
def test_environment_api_key_is_accepted(
    test_db: Session,
    granted_device: tuple[Kind, ResourceMember],
    spec: dict[str, Any],
) -> None:
    device, grant = granted_device
    device.json = {"spec": spec}
    test_db.commit()
    environment = execution_environment_values(
        test_db, grant, device, connection_status="online"
    )

    require_project_execution_environment(
        test_db, project_id="123", execution_device_id=str(environment["device_key"])
    )


@pytest.mark.parametrize(
    "restriction",
    ["other_project", "workspace_only", "pending", "inactive", "other_installation"],
)
def test_unavailable_environment_is_rejected(
    test_db: Session,
    granted_device: tuple[Kind, ResourceMember],
    restriction: str,
) -> None:
    device, grant = granted_device
    submitted_id = f"app-record-{device.id}"
    if restriction == "other_project":
        grant.entity_id = "456"
    elif restriction == "workspace_only":
        grant.entity_type = "workspace"
    elif restriction == "pending":
        grant.status = MemberStatus.PENDING.value
    elif restriction == "inactive":
        device.is_active = False
    else:
        other = Kind(
            kind="Device",
            name=device.name,
            namespace="other-installation",
            user_id=device.user_id,
            is_active=True,
            json=device.json,
        )
        test_db.add(other)
        test_db.flush()
        submitted_id = f"app-record-{other.id}"
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        require_project_execution_environment(
            test_db, project_id="123", execution_device_id=submitted_id
        )

    assert error.value.status_code == 422
    assert (
        error.value.detail == "Execution environment is not configured in this Project"
    )
