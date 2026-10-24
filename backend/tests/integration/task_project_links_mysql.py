"""CI-covered MySQL checks for project unlinking alongside task creation."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Connection, Engine, make_url
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore


def _finish_reserved_task(
    store: SqlAlchemyTaskStore, db: Session, task_id: int
) -> None:
    store.create_workspace(
        db,
        user_id=1,
        name=f"workspace-{task_id}",
        namespace="default",
        payload={},
        client_origin="frontend",
    )
    store.create_task(
        db,
        task_id=task_id,
        user_id=1,
        name=f"task-{task_id}",
        namespace="default",
        payload={},
        client_origin="frontend",
    )
    db.commit()
    assert db.get(TaskResource, task_id).kind == "Task"


def verify_unrelated_task_creation(engine: Engine, *, linked_task: bool) -> None:
    """Project cleanup must not lock another task's reserved primary key."""
    store = SqlAlchemyTaskStore()
    with Session(engine, autoflush=False) as creator:
        task_id = store.create_placeholder_task_id(creator, user_id=1)
        if linked_task:
            store.create_task_resource(
                creator,
                user_id=1,
                name="linked-task",
                namespace="default",
                payload={},
                client_origin="frontend",
                project_id=2,
            )
            creator.commit()
        assert store.get_by_id_for_update(creator, task_id=task_id) is not None

        def unlink() -> int:
            with Session(engine, autoflush=False) as cleanup:
                cleanup.execute(text("SET SESSION innodb_lock_wait_timeout = 2"))
                count = store.clear_project_for_owned_tasks(
                    cleanup, project_id=2, user_id=1, client_origin="frontend"
                )
                cleanup.commit()
                return count

        # Keep the unrelated primary key locked until cleanup has committed.
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(unlink).result(timeout=10) == int(linked_task)
        _finish_reserved_task(store, creator, task_id)
    print(f"MySQL: project cleanup linked_task={linked_task} leaves creation unlocked")


def verify_concurrent_project_move(engine: Engine) -> None:
    """A project change after discovery must not be overwritten by cleanup."""
    store = SqlAlchemyTaskStore()
    with Session(engine) as db:
        task = store.create_task_resource(
            db,
            user_id=1,
            name="relocated-task",
            namespace="default",
            payload={},
            client_origin="frontend",
            project_id=2,
        )
        db.commit()
        task_id = task.id
    moved = False

    def move_after_discovery(
        _connection: Connection,
        _cursor: Any,
        statement: str,
        _parameters: Any,
        _context: Any,
        _many: bool,
    ) -> None:
        nonlocal moved
        if moved or not statement.startswith("SELECT tasks.id"):
            return
        moved = True
        with Session(engine) as mover:
            store.update_fields(
                mover, task=mover.get(TaskResource, task_id), project_id=3
            )
            mover.commit()

    event.listen(engine, "after_cursor_execute", move_after_discovery)
    try:
        with Session(engine, autoflush=False) as cleanup:
            assert (
                store.clear_project_for_owned_tasks(
                    cleanup, project_id=2, user_id=1, client_origin="frontend"
                )
                == 0
            )
            cleanup.commit()
    finally:
        event.remove(engine, "after_cursor_execute", move_after_discovery)
    assert moved
    with Session(engine) as db:
        assert db.get(TaskResource, task_id).project_id == 3
    print("MySQL: cleanup preserves a concurrent move to another project")


def main() -> None:
    url = make_url(os.environ["TASK_PROJECT_LINK_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("Only an explicitly configured local/CI MySQL is allowed")
    database = "test_task_project_links_" + uuid.uuid4().hex
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
        verify_unrelated_task_creation(engine, linked_task=False)
        verify_unrelated_task_creation(engine, linked_task=True)
        verify_concurrent_project_move(engine)
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as connection:
                connection.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
