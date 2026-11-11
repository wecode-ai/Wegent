"""Serialize native execution admission with changes to its Thread owner."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, CollaborationChatGroup
from app.schemas.base_role import BaseRole
from app.services.collaboration_container_access import (
    get_collaboration_container,
    lock_scoped_thread,
    require_collaboration_container_access,
)
from app.services.thread_participation import require_thread_participation


def lock_execution_subject(
    db: Session, *, container_id: str, thread_id: str, actor_user_id: int
) -> None:
    """Scope is checked here; the existing resource policy still admits the run."""
    container = get_collaboration_container(db, container_id)
    if container is None:
        raise HTTPException(404, "Work container not found")
    if isinstance(container, CollaborationChatGroup):
        require_collaboration_container_access(
            db, container_id, actor_user_id, BaseRole.Developer, write=True
        )
    elif isinstance(container, CloudProject) and container.task_provider in {
        "github",
        "gitlab",
    }:
        # Provider-owned Issues have no native Thread row and cannot be rehomed.
        return
    thread = lock_scoped_thread(db, container_id, thread_id)
    require_thread_participation(db, thread, actor_user_id, execute=True)
