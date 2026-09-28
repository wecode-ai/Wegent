"""Code Wiki-specific adapters for generic subscription execution lifecycle hooks."""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.wiki import WikiGeneration
from app.schemas.subscription import BackgroundExecutionStatus
from app.services.knowledge.code_wiki.version_store import BACKGROUND_EXECUTION_EXT_KEY
from app.services.subscription.helpers import validate_subscription_for_read


@dataclass(frozen=True)
class ExecutionTimeoutPolicy:
    threshold_hours: float
    task_to_cancel: tuple[int, int] | None = None


def execution_timeout_policy(
    db: Session,
    execution: BackgroundExecution,
    *,
    default_hours: float,
    running_hours: float,
) -> ExecutionTimeoutPolicy:
    """Resolve the deadline and downstream cancellation without committing writes."""
    from app.services.knowledge.code_wiki.scheduled_update import (
        is_code_wiki_scheduled_update,
    )

    subscription = db.get(Kind, execution.subscription_id)
    if subscription is None or not is_code_wiki_scheduled_update(subscription):
        return ExecutionTimeoutPolicy(default_hours)
    crd = validate_subscription_for_read(subscription.json)
    threshold_hours = crd.spec.timeoutSeconds / 3600
    if running_hours <= threshold_hours or execution.task_id <= 0:
        return ExecutionTimeoutPolicy(threshold_hours)
    generation = (
        db.query(WikiGeneration)
        .filter(WikiGeneration.task_id == execution.task_id)
        .order_by(WikiGeneration.id.desc())
        .first()
    )
    runner_id = generation.user_id if generation else execution.user_id
    return ExecutionTimeoutPolicy(threshold_hours, (execution.task_id, runner_id))


def recover_scheduled_execution_for_task(
    db: Session, task_id: int
) -> BackgroundExecution | None:
    """Recover and commit the execution link persisted before Task dispatch.

    The caller has already exhausted ordinary task-id lookups. The launcher's
    Task can finish before it binds BackgroundExecution.task_id.
    """
    generation = (
        db.query(WikiGeneration)
        .filter(WikiGeneration.task_id == task_id)
        .order_by(WikiGeneration.id.desc())
        .first()
    )
    execution_id = (
        (generation.ext or {}).get(BACKGROUND_EXECUTION_EXT_KEY)
        if generation is not None
        else None
    )
    if not isinstance(execution_id, int) or execution_id <= 0:
        return None
    execution = db.get(BackgroundExecution, execution_id)
    if execution is None or execution.status not in {
        BackgroundExecutionStatus.PENDING.value,
        BackgroundExecutionStatus.RUNNING.value,
    }:
        return execution
    if execution.task_id not in {0, task_id}:
        return None
    if execution.task_id == 0:
        execution.task_id = task_id
        db.commit()
    return execution
