# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build the authoritative first-screen project-board read snapshot."""

from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.schemas.cloud_project import CloudProjectMemberResponse
from app.schemas.delivery import (
    LoopItemResponse,
    LoopItemTaskBindingResponse,
)
from app.schemas.project_board import ProjectBoardSnapshotResponse
from app.services.cloud_projects import cloud_project_service
from app.services.loop_items import loop_item_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.project_chat.service import project_chat_service


class ProjectBoardSnapshotService:
    def list_item_views(
        self,
        db: Session,
        project_id: int,
        user_id: int,
        *,
        assignee_type: str | None = None,
        assignee_id: str | None = None,
        execution_state: str | None = None,
    ) -> tuple[CloudProject, list[LoopItemResponse]]:
        project = cloud_project_service.get(db, project_id, user_id)
        if project.task_provider in {"github", "gitlab"}:
            items = external_loop_item_provider.list(
                db,
                project_id,
                user_id,
                assignee_type=assignee_type,
                assignee_id=assignee_id,
            )
            return project, [LoopItemResponse.model_validate(item) for item in items]

        items = loop_item_service.list(
            db,
            project_id,
            user_id,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
            execution_state=execution_state,
        )
        access = cloud_project_service.access(db, project_id, user_id)
        return project, [
            LoopItemResponse.model_validate(
                loop_item_service.response_values(
                    db,
                    item,
                    user_id,
                    access=access,
                )
            )
            for item in items
        ]

    def get(
        self,
        db: Session,
        project_id: int,
        user_id: int,
    ) -> ProjectBoardSnapshotResponse:
        _, items = self.list_item_views(db, project_id, user_id)
        item_ids = [item.id for item in items]
        bindings = loop_item_service.list_project_task_bindings(
            db,
            project_id,
            user_id,
            item_ids=item_ids,
        )
        members = cloud_project_service.list_members(db, project_id, user_id)
        agents = project_chat_service.list_agents(
            db,
            user_id=user_id,
            project_id=str(project_id),
        )
        return ProjectBoardSnapshotResponse(
            items=items,
            task_bindings=[
                LoopItemTaskBindingResponse.model_validate(binding)
                for binding in bindings
            ],
            members=[
                CloudProjectMemberResponse.model_validate(member) for member in members
            ],
            agents=agents,
        )


project_board_snapshot_service = ProjectBoardSnapshotService()
