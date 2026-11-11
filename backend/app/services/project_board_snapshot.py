# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build the authoritative first-screen project-board read snapshot."""

from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import CollaborationChatGroup
from app.schemas.cloud_project import CloudProjectMemberResponse
from app.schemas.delivery import (
    LoopItemResponse,
    LoopItemTaskBindingResponse,
)
from app.schemas.project_board import ProjectBoardSnapshotResponse
from app.services.chat_group_access import chat_group_members
from app.services.cloud_projects import cloud_project_service
from app.services.cloud_projects.access import CloudProjectAccess
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import project_chat_service
from app.services.project_thread_aggregation import (
    external_project_thread_values,
    linked_thread_values,
)


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
        access = require_collaboration_container_access(db, project_id, user_id)
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
            values = items + external_project_thread_values(
                db,
                str(project.id),
                user_id,
                assignee_type=assignee_type,
                assignee_id=assignee_id,
                execution_state=execution_state,
            )
            from app.services.project_board_order import project_order_values

            return [
                LoopItemResponse.model_validate(value)
                for value in project_order_values(project, values)
            ]

        items = loop_item_service.list_for_access(
            db,
            access,
            user_id,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
            execution_state=execution_state,
            include_project_threads=not isinstance(project, CollaborationChatGroup),
        )
        values = loop_item_service.response_values_many(
            db,
            [item for item in items if item.cloud_project_id == project.id],
            user_id,
            access=access,
        )
        if not isinstance(project, CollaborationChatGroup):
            values.extend(
                linked_thread_values(
                    db,
                    [item for item in items if item.cloud_project_id != project.id],
                    user_id,
                )
            )
        if not isinstance(project, CollaborationChatGroup):
            from app.services.project_board_order import project_order_values

            values = project_order_values(project, values)
        by_id = {value["id"]: value for value in values}
        return [
            LoopItemResponse.model_validate(by_id[item.id])
            for item in items
            if item.id in by_id
        ]

    def get(
        self,
        db: Session,
        project_id: int,
        user_id: int,
    ) -> ProjectBoardSnapshotResponse:
        access = require_collaboration_container_access(db, project_id, user_id)
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
        members = (
            chat_group_members(db, access.project.id)
            if isinstance(access.project, CollaborationChatGroup)
            else cloud_project_service.list_members_for_access(db, access, user_id)
        )
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
