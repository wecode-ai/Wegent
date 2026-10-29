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
from app.services.cloud_projects.access import CloudProjectAccess
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service
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
        access = cloud_project_service.access(db, project_id, user_id)
        return access.project, self._item_views(
            db,
            access,
            user_id,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
            execution_state=execution_state,
        )

    def _item_views(
        self,
        db: Session,
        access: CloudProjectAccess,
        user_id: int,
        *,
        assignee_type: str | None = None,
        assignee_id: str | None = None,
        execution_state: str | None = None,
    ) -> list[LoopItemResponse]:
        project = access.project
        if project.task_provider in {"github", "gitlab"}:
            items = external_loop_item_provider.list(
                db,
                project.id,
                user_id,
                assignee_type=assignee_type,
                assignee_id=assignee_id,
            )
            return [LoopItemResponse.model_validate(item) for item in items]

        items = loop_item_service.list_for_access(
            db,
            access,
            user_id,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
            execution_state=execution_state,
        )
        return [
            LoopItemResponse.model_validate(values)
            for values in loop_item_service.response_values_many(
                db, items, user_id, access=access
            )
        ]

    def get(
        self,
        db: Session,
        project_id: int,
        user_id: int,
    ) -> ProjectBoardSnapshotResponse:
        access = cloud_project_service.access(db, project_id, user_id)
        items = self._item_views(db, access, user_id)
        if access.is_viewer:
            return ProjectBoardSnapshotResponse(
                items=items,
                task_bindings=[],
                members=[],
                agents=[],
            )
        item_ids = [item.id for item in items]
        bindings = loop_item_service.list_project_task_bindings_for_access(
            db,
            access,
            user_id=user_id,
            item_ids=item_ids,
        )
        members = cloud_project_service.list_members_for_access(db, access, user_id)
        agents = project_chat_service.list_agents_for_access(
            db,
            access,
            user_id=user_id,
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
