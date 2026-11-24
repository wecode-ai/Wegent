"""Inspect or remove executor session proof for the CI-covered E2E."""

import json
import os

from sqlalchemy.engine import make_url


def main() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() != "mysql" or url.database != "wegent_test":
        raise RuntimeError("Fixture requires the isolated MySQL wegent_test database")

    data = json.loads(os.environ["WEGENT_ISOLATED_DATABASE_REQUEST"])
    operation = data.get("operation", "remove")
    task_id = int(data["task_id"])
    user_id = int(data["user_id"])

    from app.db.session import SessionLocal
    from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus

    with SessionLocal() as db:
        rows = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.user_id == user_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.COMPLETED,
            )
            .order_by(Subtask.id.desc())
            .all()
        )
        if not rows:
            raise RuntimeError(
                "Fixture requires at least one completed assistant subtask"
            )

        sessions = [
            row.result["executor_session"]
            for row in rows
            if isinstance(row.result, dict) and row.result.get("executor_session")
        ]
        if not sessions:
            raise RuntimeError("Fixture found no persisted executor_session proof")

        if operation == "inspect":
            print(json.dumps({"task_id": task_id, "sessions": sessions}))
            return
        if operation != "remove":
            raise RuntimeError(
                f"Unknown executor session fixture operation: {operation}"
            )

        removed = 0
        for row in rows:
            result = row.result
            if isinstance(result, dict) and "executor_session" in result:
                updated = dict(result)
                updated.pop("executor_session")
                row.result = updated
                removed += 1
        if removed == 0:
            raise RuntimeError("Fixture found no persisted executor_session proof")
        db.commit()
        db.expire_all()
        remaining = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.user_id == user_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.COMPLETED,
            )
            .order_by(Subtask.id.desc())
            .all()
        )
        if any(
            isinstance(row.result, dict) and "executor_session" in row.result
            for row in remaining
        ):
            raise RuntimeError("Executor session proof removal was not persisted")
        print(
            json.dumps({"task_id": task_id, "removed": removed, "sessions": sessions})
        )


if __name__ == "__main__":
    main()
