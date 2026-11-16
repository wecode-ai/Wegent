"""Validate Issue associations using the same lock as milestone deletion."""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.delivery import ProjectMilestone, loop_datetime_is_unset


def require_milestone(db: Session, project_id: str, milestone_id: str | None) -> None:
    if milestone_id is None:
        return
    milestone = db.execute(
        select(ProjectMilestone)
        .where(
            ProjectMilestone.id == milestone_id,
            ProjectMilestone.cloud_project_id == project_id,
            loop_datetime_is_unset(ProjectMilestone.deleted_at),
        )
        .with_for_update()
    ).scalar_one_or_none()
    if milestone is None:
        raise HTTPException(422, "Milestone does not belong to this project")
