"""Derive public authorship from persisted identities, never message text."""

from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User

SHARED_METADATA_KEYS = frozenset(
    {
        "mentions",
        "stand_in_reply_to",
        "execution_dispatch",
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
        "workflow_task_title",
        "execution_id",
    }
)


def shared_message_metadata(metadata: object) -> dict[str, object]:
    if not isinstance(metadata, dict):
        return {}
    return {key: metadata[key] for key in SHARED_METADATA_KEYS if key in metadata}


def is_private_execution_message(message_type: str, metadata: object) -> bool:
    return message_type in {"agent_status", "agent_chunk"} or (
        isinstance(metadata, dict) and metadata.get("kind") == "task_ai_subagent"
    )


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
