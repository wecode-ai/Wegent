"""Derive public authorship from persisted identities, never message text."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User

SHARED_METADATA_KEYS = frozenset(
    {
        "mentions",
        "stand_in_reply_to",
        "execution_dispatch",
        "collaboration_public_reply",
        "collaboration_guidance",
        "collaboration_execution_activity_id",
        "activity_type",
        "dispatch_role",
        "manager_display_name",
        "run_status",
        "summary",
        "evidence_refs",
        "next_action",
        "publish_policy",
        "imported_from",
        "history_import",
        "member_assistant_result",
        "runtime_event_sequence",
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


def is_private_execution_message(message_type: str, metadata: object) -> bool:
    return message_type in {"agent_status", "agent_chunk"} or (
        isinstance(metadata, dict) and metadata.get("kind") == "task_ai_subagent"
    )


def shared_project_chat_message(message: dict[str, Any]) -> dict[str, Any]:
    """Return the room-safe projection without changing the owner's response."""
    shared = dict(message)
    if is_private_execution_message(
        str(message.get("type", "")), message.get("metadata")
    ):
        shared["content"] = ""
        if shared.get("type") == "text":
            shared["type"] = "agent_chunk"
    if "metadata" in shared:
        shared["metadata"] = shared_message_metadata(shared["metadata"])
    if "runtimeAddress" in shared:
        shared["runtimeAddress"] = None
        shared["traceState"] = (
            "restricted" if shared.get("traceRef") else "history-unavailable"
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
    verified_source = isinstance(assistant_publication, dict) and (
        assistant_publication.get("source_verified") is True
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
            if verified_publication or verified_source
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
