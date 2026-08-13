# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitLab MR integration management endpoints for a cloud project."""

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.gitlab.integration_service import mr_integration_service

router = APIRouter(prefix="/v1/cloud-projects", tags=["cloud-projects-gitlab-mr"])


@router.post("/{project_id}/gitlab/mr-integration")
def enable_mr_integration(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    """Install the GitLab webhook for a project's repository and enable MR cards."""
    access = require_cloud_project_role(
        db, project_id, current_user.id, BaseRole.Maintainer
    )
    mr_integration_service.enable(db, access.project, current_user.id)
    db.commit()
    return mr_integration_service.status(db, access.project)


@router.get("/{project_id}/gitlab/mr-integration")
def get_mr_integration_status(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    """Return MR integration status, re-verifying the installed hook."""
    access = require_cloud_project_role(
        db, project_id, current_user.id, BaseRole.Reporter
    )
    result = mr_integration_service.status(db, access.project)
    db.commit()
    return result


@router.delete(
    "/{project_id}/gitlab/mr-integration", status_code=status.HTTP_204_NO_CONTENT
)
def disable_mr_integration(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """Remove the GitLab webhook and its MR records; board cards stay."""
    access = require_cloud_project_role(
        db, project_id, current_user.id, BaseRole.Maintainer
    )
    mr_integration_service.disable(db, access.project)
    db.commit()
    return None
