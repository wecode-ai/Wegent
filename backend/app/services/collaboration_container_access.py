# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Explicit scope gateway for work, chat and delivery, never project management."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    CollaborationChatGroup,
    LoopItem,
    LoopNode,
    loop_datetime_is_unset,
)
from app.schemas.base_role import BaseRole, has_permission
from app.services.chat_group_access import chat_group_role
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    require_cloud_project_role,
)


def lock_scoped_thread(
    db: Session, group_id: str, thread_id: str, *, include_deleted: bool = False
) -> LoopItem:
    """Lock the live Thread in the container the caller has authorized."""
    query = db.query(LoopItem).filter(
        LoopItem.id == thread_id,
        LoopItem.cloud_project_id == group_id,
    )
    if not include_deleted:
        query = query.filter(loop_datetime_is_unset(LoopItem.deleted_at))
    thread = query.with_for_update().populate_existing().one_or_none()
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    return thread


def get_collaboration_container(
    db: Session, container_id: int | str
) -> CloudProject | CollaborationChatGroup | None:
    container = db.get(LoopNode, str(container_id))
    return (
        container
        if isinstance(container, (CloudProject, CollaborationChatGroup))
        else None
    )


def require_collaboration_container_access(
    db: Session,
    container_id: int | str,
    user_id: int,
    required_role: BaseRole = BaseRole.Viewer,
    *,
    write: bool = False,
) -> CloudProjectAccess:
    container = get_collaboration_container(db, container_id)
    if not isinstance(container, CollaborationChatGroup):
        return require_cloud_project_role(db, container_id, user_id, required_role)
    role = chat_group_role(
        db, container_id, user_id, lock=write or required_role != BaseRole.Viewer
    )
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Chat group not found")
    if not has_permission(role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    if container.status == "archived" and (write or required_role != BaseRole.Viewer):
        raise HTTPException(status.HTTP_409_CONFLICT, "Chat group is archived")
    return CloudProjectAccess(
        project=container,
        role=role,
        sources=({"type": "group", "role": role.value},),
    )
