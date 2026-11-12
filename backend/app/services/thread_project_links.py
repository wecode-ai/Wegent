"""Optional project classification never replaces the owning group's authority."""

import hashlib

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CollaborationChatGroup,
    LoopItem,
    LoopNode,
    ThreadProjectLink,
    loop_datetime_is_unset,
)
from app.services.project_classification_access import require_classification_project
from app.services.project_milestones import require_milestone


def prepare_thread_classification(
    db: Session, container: LoopNode, user_id: int, project_id: str | None
) -> LoopNode | None:
    """Lock target authority before creating a classified Thread in its group."""
    if project_id is None:
        return None
    if not isinstance(container, CollaborationChatGroup):
        raise HTTPException(422, "Project classification requires an owning group")
    if (
        not project_id.isascii()
        or not project_id.isdecimal()
        or str(int(project_id)) != project_id
        or not 0 < int(project_id) <= 2**63 - 1
    ):
        raise HTTPException(422, "Invalid project identity")
    return require_classification_project(db, project_id, user_id)


def create_thread_classification(
    db: Session, thread: LoopItem, project: LoopNode
) -> None:
    digest = hashlib.sha256(f"thread-project:{thread.id}".encode()).digest()
    key = str(int.from_bytes(digest[:8], "big") & ((1 << 63) - 1))
    if db.get(LoopNode, key) is not None:
        raise HTTPException(409, "Project link identity collision")
    db.add(
        ThreadProjectLink(
            id=key,
            parent_id=project.id,
            loop_item_id=thread.id,
            status="active",
            created_by_user_id=thread.created_by_user_id,
        )
    )
    db.flush()


def linked_project_id(db: Session, thread_id: str, *, lock: bool = False) -> str | None:
    query = db.query(ThreadProjectLink.parent_id).filter(
        ThreadProjectLink.loop_item_id == thread_id,
        ThreadProjectLink.status == "active",
        loop_datetime_is_unset(ThreadProjectLink.deleted_at),
    )
    if lock:
        query = query.with_for_update()
    row = query.one_or_none()
    return str(row[0]) if row else None


def require_thread_milestone(
    db: Session, thread: LoopItem, user_id: int, milestone_id: str | None
) -> None:
    current = (thread.metadata_json or {}).get("milestone_id")
    if milestone_id is None and not current:
        return
    project_id = str(thread.cloud_project_id)
    if db.get(CollaborationChatGroup, project_id) is not None:
        project_id = linked_project_id(db, str(thread.id))
        if project_id is None:
            raise HTTPException(422, "Associate a project before choosing a milestone")
        require_classification_project(db, project_id, user_id)
    if milestone_id is not None:
        require_milestone(db, project_id, milestone_id)
