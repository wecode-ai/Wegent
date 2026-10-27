"""CI-covered MySQL regression for project deletion beside task creation."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore


def create_unrelated_task(engine: Engine, suffix: str) -> None:
    """Exercise workspace insertion and reserved task activation in one transaction."""
    with Session(engine) as db:
        db.execute(text("SET SESSION innodb_lock_wait_timeout = 1"))
        db.add(
            TaskResource(
                user_id=1,
                kind="Workspace",
                name=f"workspace-{suffix}",
                json={},
                project_id=0,
            )
        )
        placeholder = db.get(TaskResource, 1)
        placeholder.kind = "Task"
        placeholder.name = "task-1"
        db.commit()


def verify_detachment_does_not_lock_unrelated_tasks(engine: Engine) -> None:
    """Keep deletion uncommitted while an unrelated task completes without retry."""
    store = SqlAlchemyTaskStore()
    for project_id, expected in ((999, 0), (7, 1)):
        with Session(engine) as deleting:
            assert (
                store.clear_project_for_owned_tasks(
                    deleting,
                    project_id=project_id,
                    user_id=1,
                    client_origin="frontend",
                )
                == expected
            )
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(create_unrelated_task, engine, str(project_id)).result(
                    timeout=10
                )
            deleting.commit()
        with Session(engine) as db:
            assert db.get(TaskResource, 1).kind == "Task"
            assert db.get(TaskResource, 2).project_id == (7 if project_id == 999 else 0)
            assert db.get(TaskResource, 3).project_id == 7
            assert db.get(TaskResource, 4).project_id == 7
    print("MySQL: project detachment leaves unrelated task creation unlocked")


def main() -> None:
    """Run against a dedicated database on an explicitly configured local MySQL."""
    url = make_url(os.environ["PROJECT_TASK_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("Only an explicitly configured local/CI MySQL is allowed")
    database = "test_project_task_detachment_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    created = False
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f"CREATE DATABASE `{database}`")
            created = True
        engine = create_engine(
            url.set(database=database), isolation_level="REPEATABLE READ"
        )
        TaskResource.__table__.create(engine)
        with Session(engine) as db:
            for task_id, owner, kind, project_id, origin in (
                (1, 1, "Placeholder", 0, "frontend"),
                (2, 1, "Task", 7, "frontend"),
                (3, 2, "Task", 7, "frontend"),
                (4, 1, "Task", 7, "wework"),
            ):
                db.add(
                    TaskResource(
                        id=task_id,
                        user_id=owner,
                        kind=kind,
                        name=f"{kind.lower()}-{task_id}",
                        json={},
                        project_id=project_id,
                        client_origin=origin,
                    )
                )
            db.commit()
        verify_detachment_does_not_lock_unrelated_tasks(engine)
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as connection:
                connection.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
