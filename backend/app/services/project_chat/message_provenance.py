"""Derive public authorship from persisted identities, never message text."""

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.models.delivery import ProjectChatAgent, loop_datetime_is_unset
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User

logger = logging.getLogger(__name__)

SHARED_METADATA_KEYS = frozenset(
    {
        "mentions",
        "stand_in_reply_to",
        "stand_in",
        "execution_dispatch",
        "activity_type",
        "dispatch_role",
        "manager_display_name",
        "run_status",
        "activity_at",
        "conversation_only",
        "kind",
        "dispatch_id",
        "coordination_round_id",
        "dispatch_assignments",
        "summary",
        "evidence_refs",
        "next_action",
        "publish_policy",
        "imported_from",
        "history_import",
        "member_assistant_result",
    }
)

SHARED_RUNTIME_METADATA_KEYS = frozenset(
    {
        "run_id",
        "execution_id",
        "executor_type",
        "backend_task_id",
        "execution_url",
        "model",
        "runtime_event_sequence",
        "contentMode",
        "runtime_turn_id",
        "workflow_task_title",
    }
)


def shared_message_metadata(
    metadata: object, *, include_runtime: bool = False
) -> dict[str, object]:
    if not isinstance(metadata, dict):
        return {}
    keys = (
        SHARED_METADATA_KEYS | SHARED_RUNTIME_METADATA_KEYS
        if include_runtime
        else SHARED_METADATA_KEYS
    )
    return {key: metadata[key] for key in keys if key in metadata}


def broadcast_message_payload(message: dict[str, Any]) -> dict[str, Any] | None:
    """Project a committed message for API and cross-process room delivery."""

    try:
        with get_db_session() as db:
            return shared_message_payload(message, db=db)
    except Exception:
        logger.exception(
            "[ProjectChat] Room projection failed message_id=%s",
            message.get("messageId"),
        )
        return None


def shared_message_payload(
    message: dict[str, Any], *, db: Session
) -> dict[str, Any] | None:
    """Derive room authority from persisted identity, never the sender's view."""

    from app.services.project_chat.service import project_chat_service

    row = (
        db.query(ProjectChatMessage)
        .filter_by(
            message_id=message.get("messageId"),
            project_id=message.get("projectId"),
            task_id=message.get("taskId") or "",
        )
        .filter(loop_datetime_is_unset(ProjectChatMessage.deleted_at))
        .first()
    )
    if row is None:
        return None
    runtime_shared = message_runtime_is_shared(db, row)
    canonical = project_chat_service.to_view(row, db=db)

    shared = dict(message)
    if "metadata" in shared:
        shared["metadata"] = shared_message_metadata(
            shared["metadata"], include_runtime=runtime_shared
        )
    if shared.get("type") in {"agent_status", "agent_chunk"}:
        shared["content"] = ""
    shared["actorUserId"] = canonical.actor_user_id
    shared["actorDisplayName"] = canonical.actor_display_name
    shared["runtimeAddress"] = canonical.runtime_address if runtime_shared else None
    shared["traceRef"] = canonical.trace_ref
    shared["traceState"] = (
        canonical.trace_state
        if runtime_shared
        else ("restricted" if canonical.trace_ref else "history-unavailable")
    )
    return shared


def message_actor_id(db: Session, row: ProjectChatMessage) -> int | None:
    if row.sender_type == "user":
        return int(row.sender_id) if row.sender_id.isdecimal() else None
    metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    identity = metadata.get("stand_in")
    if isinstance(identity, dict):
        user_id = identity.get("user_id")
        if type(user_id) is int and user_id > 0:
            return user_id
    if row.trigger_message_id:
        trigger = (
            db.query(ProjectChatMessage)
            .filter_by(
                message_id=row.trigger_message_id,
                project_id=row.project_id,
                task_id=row.task_id,
                sender_type="user",
            )
            .first()
        )
        if trigger is not None and trigger.sender_id.isdecimal():
            return int(trigger.sender_id)
    if row.agent_id:
        agent = (
            db.query(ProjectChatAgent)
            .filter_by(id=row.agent_id, cloud_project_id=row.project_id)
            .first()
        )
        if agent is not None:
            return agent.created_by_user_id
    return None


def message_runtime_owner_id(db: Session, row: ProjectChatMessage) -> int | None:
    """Return the identity that owns the persisted Runtime address."""

    if row.sender_type == "user":
        return int(row.sender_id) if row.sender_id.isdecimal() else None
    metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    identity = metadata.get("stand_in")
    if isinstance(identity, dict):
        user_id = identity.get("user_id")
        if type(user_id) is int and user_id > 0:
            return user_id
    if row.agent_id:
        agent = (
            db.query(ProjectChatAgent)
            .filter_by(id=row.agent_id, cloud_project_id=row.project_id)
            .first()
        )
        if agent is not None:
            return agent.created_by_user_id
    if row.trigger_message_id:
        trigger = (
            db.query(ProjectChatMessage)
            .filter_by(
                message_id=row.trigger_message_id,
                project_id=row.project_id,
                task_id=row.task_id,
                sender_type="user",
            )
            .first()
        )
        if trigger is not None and trigger.sender_id.isdecimal():
            return int(trigger.sender_id)
    return None


def message_runtime_is_shared(db: Session, row: ProjectChatMessage) -> bool:
    """Whether a project-visible Agent owns this shared Runtime source."""

    if row.sender_type != "agent" or not row.agent_id:
        return False
    metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    if "stand_in" in metadata:
        return False
    agent = (
        db.query(ProjectChatAgent)
        .filter_by(id=row.agent_id, cloud_project_id=row.project_id)
        .first()
    )
    if agent is None:
        return False
    agent_metadata = (
        agent.metadata_json if isinstance(agent.metadata_json, dict) else {}
    )
    return agent_metadata.get("visibility") != "private"


def message_provenance(db: Session, row: ProjectChatMessage) -> dict[str, object]:
    """Unconfirmed AI output never acquires authority from its own metadata."""

    metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    historical = bool(metadata.get("history_import") or metadata.get("imported_from"))
    assistant_publication = metadata.get("assistant_publication")
    verified_publication = isinstance(assistant_publication, dict) and (
        assistant_publication.get("verified") is True
    )
    published_by = (
        assistant_publication.get("published_by")
        if verified_publication and isinstance(assistant_publication, dict)
        else None
    )
    source = (
        "human"
        if historical
        else (
            "ai"
            if verified_publication
            else {"user": "human", "agent": "ai"}.get(row.sender_type, "system")
        )
    )
    actor_id = message_actor_id(db, row) if source != "system" else None
    actor = db.get(User, actor_id) if actor_id is not None else None
    name = actor.user_name if isinstance(actor, User) else None
    return {
        "actor_user_id": str(actor_id) if actor_id is not None else None,
        "actor_display_name": name or None,
        "generation_source": source,
        "publication_source": (
            "ai"
            if published_by == "ai"
            else "human" if verified_publication else source
        ),
        "confirmation_state": (
            "unknown"
            if historical
            else (
                "not_required"
                if published_by == "ai"
                else (
                    "authorized"
                    if verified_publication
                    else "pending" if source == "ai" else "not_required"
                )
            )
        ),
    }
