"""Load discussion roots and the active human question with a message page."""

from sqlalchemy.orm import Query, Session

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage


def include_thread_context(
    db: Session,
    *,
    query: Query,
    rows: list[ProjectChatMessage],
    task_id: str | None,
) -> list[ProjectChatMessage]:
    """Use the caller's authorized, non-deleted message scope for all context."""
    by_id = {row.message_id: row for row in rows}
    issue = db.get(LoopItem, task_id) if task_id else None
    assignment = (
        (((issue.metadata_json or {}).get("workflow") or {}).get("assignment") or {})
        if issue
        else {}
    )
    if assignment.get("status") == "waiting_human":
        question = (
            query.filter(
                ProjectChatMessage.sender_type == "system",
                ProjectChatMessage.sender_id == "issue_assignment",
                ProjectChatMessage.metadata_json["issue_assignment"]["id"].as_string()
                == assignment["id"],
                ProjectChatMessage.metadata_json["issue_assignment"][
                    "status"
                ].as_string()
                == "waiting_human",
            )
            .order_by(ProjectChatMessage.id)
            .first()
        )
        if question is not None:
            by_id[question.message_id] = question
    root_ids = (
        {row.thread_root_message_id for row in by_id.values()} - {""} - by_id.keys()
    )
    if root_ids:
        for root in query.filter(ProjectChatMessage.message_id.in_(root_ids)).all():
            by_id[root.message_id] = root
    return sorted(by_id.values(), key=lambda row: row.id)
