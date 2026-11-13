"""Server-owned answer attempt identity and commit outcomes."""

from enum import Enum
from uuid import uuid4

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskStatus
from app.stores.tasks import subtask_store

ANSWER_SAVE_UNCONFIRMED_MESSAGE = "回答保存状态未确认，请刷新历史核对。"


class AnswerSaveResult(Enum):
    COMMITTED = "committed"
    REJECTED = "rejected"
    UNCONFIRMED = "unconfirmed"

    def __bool__(self) -> bool:
        return self is AnswerSaveResult.COMMITTED


def accept_answer_attempt(db: Session, subtask: Subtask) -> str:
    """Accept once before asynchronous preparation; never adopt a newer identity."""
    if subtask.answer_generation_id:
        return subtask.answer_generation_id
    generation_id = uuid4().hex
    if not subtask_store.update_fields_if_attempt(
        db,
        subtask=subtask,
        generation_id=None,
        from_statuses=(SubtaskStatus.PENDING,),
        answer_generation_id=generation_id,
    ):
        raise ValueError("Answer attempt is no longer pending")
    db.commit()
    from sqlalchemy.orm.attributes import set_committed_value

    set_committed_value(subtask, "answer_generation_id", generation_id)
    return generation_id
