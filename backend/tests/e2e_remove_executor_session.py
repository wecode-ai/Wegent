"""Remove executor session proof for the CI-covered legacy continuation E2E."""

import json
import os
import sys
from typing import Any

from sqlalchemy.engine import make_url


def main() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() != "mysql" or url.database != "wegent_test":
        raise RuntimeError("Fixture requires the isolated MySQL wegent_test database")

    data = json.load(sys.stdin)
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
            raise RuntimeError("Fixture requires at least one completed assistant subtask")

        removed = 0
        for row in rows:
            result: dict[str, Any] = row.result or {}
            if "executor_session" in result:
                result.pop("executor_session")
                row.result = result
                removed += 1
        if removed == 0:
            raise RuntimeError("Fixture found no persisted executor_session proof")
        db.commit()
        print(json.dumps({"task_id": task_id, "removed": removed}))


if __name__ == "__main__":
    main()
