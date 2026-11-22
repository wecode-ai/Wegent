"""Drive and inspect an owned subscription in the existing browser CI stack."""

import json
import os
import sys
import time
from typing import Any

from sqlalchemy.engine import make_url


def owned_subscription(db: Any, data: dict[str, Any]) -> Any:
    from app.models.kind import Kind
    from app.models.user import User

    prefix = data["prefix"]
    if not prefix.startswith("e2e-recent-"):
        raise ValueError("Unexpected cancellation fixture prefix")
    owner = db.query(User).filter_by(user_name=prefix).one()
    return (
        db.query(Kind)
        .filter_by(
            id=data["subscription_id"],
            user_id=owner.id,
            namespace="default",
            name=f"{prefix}-subscription",
            kind="Subscription",
            is_active=True,
        )
        .one()
    )


def snapshot(data: dict[str, Any], task_id: int) -> dict[str, Any]:
    from app.db.session import SessionLocal
    from app.models.subscription import BackgroundExecution
    from app.models.subtask import Subtask
    from app.models.task import TaskResource

    with SessionLocal() as db:
        subscription = owned_subscription(db, data)
        db.query(BackgroundExecution).filter_by(
            subscription_id=subscription.id,
            user_id=subscription.user_id,
            task_id=task_id,
        ).one()
        task = (
            db.query(TaskResource)
            .filter_by(
                id=task_id,
                user_id=subscription.user_id,
                namespace="default",
                kind="Task",
            )
            .one()
        )
        rows = (
            db.query(Subtask)
            .filter_by(task_id=task_id, user_id=subscription.user_id)
            .order_by(Subtask.id)
            .all()
        )
        return {
            "task_id": task_id,
            "is_active": task.is_active,
            "status": task.json["status"]["status"],
            "schedule": {
                "enabled": subscription.json["_internal"]["enabled"],
                "trigger": subscription.json["spec"]["trigger"],
                "next_execution_time": subscription.json["_internal"].get(
                    "next_execution_time"
                ),
            },
            "subtasks": [
                {"id": row.id, "role": row.role.value, "status": row.status.value}
                for row in rows
            ],
        }


def prepare(data: dict[str, Any]) -> dict[str, Any]:
    from app.db.session import SessionLocal
    from app.services.subscription import subscription_service
    from app.tasks.subscription_tasks import execute_subscription_task_sync

    with SessionLocal() as db:
        subscription = owned_subscription(db, data)
        execution = subscription_service.create_execution(
            db,
            subscription=subscription,
            user_id=subscription.user_id,
            trigger_type="manual",
            trigger_reason="Owned browser cancellation E2E prerequisite",
        )
        execution_id = execution.id
    # CI has no subscription worker. Drive only this owned execution through
    # the real dispatcher, and keep its daemon alive until persistence completes.
    result = execute_subscription_task_sync(data["subscription_id"], execution_id)
    if result.get("status") != "success":
        raise RuntimeError(f"Subscription prerequisite failed: {result}")
    deadline = time.monotonic() + 15
    while True:
        state = snapshot(data, result["task_id"])
        if state["status"] in {"COMPLETED", "FAILED", "CANCELLED", "COMPLETED_SILENT"}:
            if state["status"] != "COMPLETED":
                raise RuntimeError(
                    f"Subscription prerequisite did not complete: {state}"
                )
            return state
        if time.monotonic() >= deadline:
            raise TimeoutError("Subscription prerequisite did not persist COMPLETED")
        time.sleep(0.1)


def cleanup(data: dict[str, Any]) -> dict[str, Any]:
    from app.db.session import SessionLocal
    from app.models.subscription import BackgroundExecution
    from app.models.subtask import Subtask
    from app.models.task import TaskResource
    from app.stores.tasks import subtask_store, task_store

    deadline = time.monotonic() + 10
    while True:
        with SessionLocal() as db:
            subscription = owned_subscription(db, data)
            executions = (
                db.query(BackgroundExecution)
                .filter_by(
                    subscription_id=subscription.id, user_id=subscription.user_id
                )
                .all()
            )
            tasks = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id.in_(
                        [row.task_id for row in executions if row.task_id]
                    ),
                    TaskResource.user_id == subscription.user_id,
                    TaskResource.namespace == "default",
                    TaskResource.kind == "Task",
                )
                .all()
            )
            if any(task.is_active != TaskResource.STATE_SUBSCRIPTION for task in tasks):
                raise RuntimeError(
                    "Teardown encountered an unexpected task activity state"
                )
            subtasks = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id.in_([task.id for task in tasks]),
                    Subtask.user_id == subscription.user_id,
                )
                .all()
            )
            if any(row.status.value in {"PENDING", "RUNNING"} for row in subtasks):
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "Released subscription did not settle before teardown"
                    )
                time.sleep(0.1)
                continue
            for row in subtasks:
                subtask_store.delete(db, subtask=row)
            for task in tasks:
                task_store.delete_resource(db, resource=task)
            for execution in executions:
                db.delete(execution)
            db.commit()
            return {"removed_task_ids": [task.id for task in tasks]}


def main() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() != "mysql" or url.database != "wegent_test":
        raise RuntimeError("Cancellation fixture requires isolated MySQL wegent_test")
    data = json.load(sys.stdin)
    if data["operation"] == "prepare":
        result = prepare(data)
    elif data["operation"] == "inspect":
        result = snapshot(data, data["task_id"])
    elif data["operation"] == "cleanup":
        result = cleanup(data)
    else:
        raise ValueError("Unsupported cancellation fixture operation")
    print("CANCEL_E2E_STATE " + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
