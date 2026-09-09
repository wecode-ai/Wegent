"""Keep human handoff questions and answers in their original discussion."""

from uuid import uuid4

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, loop_datetime_is_unset
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services.loop_item_unread import advance_content_revision


def assignment_thread_root(db: Session, issue: LoopItem, assignment: dict) -> str:
    scope = db.query(ProjectChatMessage).filter(
        ProjectChatMessage.project_id == str(issue.cloud_project_id),
        ProjectChatMessage.task_id == str(issue.id),
        loop_datetime_is_unset(ProjectChatMessage.deleted_at),
    )
    if assignment.get("thread_root_message_id"):
        root = scope.filter(
            ProjectChatMessage.message_id == assignment["thread_root_message_id"]
        ).one_or_none()
        return root.message_id if root else ""
    question = (
        scope.filter(
            ProjectChatMessage.sender_type == "system",
            ProjectChatMessage.sender_id == "issue_assignment",
            ProjectChatMessage.metadata_json["issue_assignment"]["id"].as_string()
            == assignment.get("id"),
            ProjectChatMessage.metadata_json["issue_assignment"]["status"].as_string()
            == "waiting_human",
        )
        .order_by(ProjectChatMessage.id)
        .first()
    )
    return (question.thread_root_message_id or question.message_id) if question else ""


def append_human_reply(
    db: Session, *, issue: LoopItem, workflow: dict, user_id: int, content: str
) -> ProjectChatMessage | None:
    """Append a user reply within the caller's assignment transaction."""
    assignment = dict(workflow["assignment"])
    if assignment.get("reply_draft") == content and assignment.get("reply_message_id"):
        return None
    root_id = assignment_thread_root(db, issue, assignment)
    if not root_id:
        raise ValueError("The assignment question is unavailable")
    user = db.get(User, user_id)
    message_id = str(uuid4())
    row = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(issue.cloud_project_id),
        task_id=str(issue.id),
        sender_type="user",
        sender_id=str(user_id),
        sender_name=user.user_name,
        message_type="text",
        content=content,
        status="completed",
        reply_to_message_id=root_id,
        thread_root_message_id=root_id,
        metadata_json={"issue_assignment_id": assignment["id"]},
    )
    db.add(row)
    assignment.update(
        reply_draft=content, reply_message_id=message_id, thread_root_message_id=root_id
    )
    workflow["assignment"] = assignment
    issue.metadata_json = advance_content_revision(
        issue.metadata_json, actor_user_id=user_id
    )
    return row


_PENDING_COMMENTS = "issue_assignment_comments"


def queue_assignment_comment(db: Session, row: ProjectChatMessage | None) -> None:
    if row is None:
        return
    from app.services.project_chat.service import project_chat_service

    db.flush()
    payload = project_chat_service.to_view(row).model_dump(by_alias=True)
    db.info.setdefault(_PENDING_COMMENTS, []).append(payload)


@event.listens_for(Session, "after_commit")
def _deliver_assignment_comments(db: Session) -> None:
    pending = db.info.pop(_PENDING_COMMENTS, [])
    if not pending:
        return
    from app.services.project_chat.push import push_project_chat_message

    for payload in pending:
        push_project_chat_message(payload)


@event.listens_for(Session, "after_rollback")
def _discard_assignment_comments(db: Session) -> None:
    db.info.pop(_PENDING_COMMENTS, None)
