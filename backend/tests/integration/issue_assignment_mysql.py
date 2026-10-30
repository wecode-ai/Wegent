"""CI-covered MySQL regression for independent initial Issue assignments."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemActiveAssignment,
    LoopNode,
)
from app.models.kind import Kind
from app.models.project import Project
from app.models.task import TaskResource
from app.models.user import User
from app.services.issue_assignments import issue_assignment_service


def verify_independent_initial_assignments(engine: Engine) -> None:
    """Force both first-comment inserts to overlap without retries."""
    ready = Barrier(2, timeout=10)

    def synchronize(connection, cursor, statement, parameters, context, executemany):
        if (
            statement.startswith("INSERT INTO loop_items")
            and parameters.get("resource_type") == "comment"
        ):
            ready.wait()

    def create(index: int) -> None:
        with Session(engine, autoflush=False) as db:
            issue = LoopItem(
                id=f"ISSUE-{index}",
                cloud_project_id=f"project-{index}",
                title="Concurrent first assignment",
                status="pending",
                created_by_user_id=1,
            )
            db.add(issue)
            db.flush()
            issue_assignment_service.record(
                db,
                project_id=issue.cloud_project_id,
                issue_id=issue.id,
                member_type="human",
                member_id="1",
                assigned_by_user_id=1,
                workflow_step=None,
                notify=True,
                trigger="default",
                initial_assignment=True,
            )
            db.commit()

    event.listen(engine, "before_cursor_execute", synchronize)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(create, index) for index in (1, 2)]
            for future in futures:
                future.result(timeout=20)
    finally:
        event.remove(engine, "before_cursor_execute", synchronize)
    with Session(engine) as db:
        active = issue_assignment_service.active_for_issues(db, ["ISSUE-1", "ISSUE-2"])
        assert all(len(events) == 1 for events in active.values())
        assert all(events[0].member_id == "1" for events in active.values())
        assert db.query(LoopItemActiveAssignment).count() == 4
    print("MySQL: independent first assignments and their indexes commit concurrently")


def verify_existing_assignment_serialization(engine: Engine) -> None:
    """A pre-lock snapshot must not hide another committed reassignment."""
    ready = Barrier(2, timeout=10)

    def assign(member_id: str) -> None:
        with Session(engine, autoflush=False) as db:
            assert db.get(LoopItem, "ISSUE-1") is not None
            ready.wait()
            issue_assignment_service.record(
                db,
                project_id="project-1",
                issue_id="ISSUE-1",
                member_type="human",
                member_id=member_id,
                assigned_by_user_id=1,
                workflow_step=None,
                notify=True,
                trigger="manual",
            )
            db.commit()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(assign, member) for member in ("2", "3")]
        for future in futures:
            future.result(timeout=20)
    with Session(engine) as db:
        active = issue_assignment_service.active_for_issue(db, "ISSUE-1")
        assert len(active) == 1
        assert active[0].member_id in {"2", "3"}
        assert db.query(LoopItemActiveAssignment).count() == 4
    print("MySQL: existing Issue assignments retain serialized current reads")


def main() -> None:
    url = make_url(os.environ["ISSUE_ASSIGNMENT_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("Only an explicitly configured local/CI MySQL is allowed")
    database = "test_issue_assignment_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f"CREATE DATABASE `{database}`")
        engine = create_engine(
            url.set(database=database), isolation_level="REPEATABLE READ"
        )
        Base.metadata.create_all(
            engine,
            tables=[
                User.__table__,
                Kind.__table__,
                Project.__table__,
                TaskResource.__table__,
                LoopNode.__table__,
            ],
        )
        with Session(engine) as db:
            for owner in (1, 2, 3):
                db.add(
                    User(id=owner, user_name=f"owner-{owner}", password_hash="unused")
                )
            for index in (1, 2):
                db.add(CloudProject(id=f"project-{index}", name=f"Project {index}"))
            db.commit()
        verify_independent_initial_assignments(engine)
        verify_existing_assignment_serialization(engine)
    finally:
        if engine is not None:
            engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f"DROP DATABASE IF EXISTS `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
