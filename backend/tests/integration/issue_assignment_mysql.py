"""CI-covered assignment concurrency checks using the application's MySQL engines."""

import asyncio
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session


def seed(engine: Engine) -> None:
    from app.models.delivery import CloudProject, LoopItem, LoopNode
    from app.models.user import User

    with engine.begin() as connection:
        # Only these real model tables are needed; external references stay NULL.
        connection.exec_driver_sql("SET FOREIGN_KEY_CHECKS = 0")
        User.__table__.create(connection)
        LoopNode.__table__.create(connection)
        connection.exec_driver_sql("SET FOREIGN_KEY_CHECKS = 1")
    with Session(engine) as db:
        db.add_all(
            User(id=index, user_name=f"member-{index}", password_hash="unused")
            for index in (1, 2)
        )
        db.add(CloudProject(id="project", name="Assignment concurrency"))
        db.flush()
        db.add_all(
            LoopItem(id=key, cloud_project_id="project", title=key)
            for key in ("independent-0", "independent-1", "shared")
        )
        db.commit()


def record(db: Session, issue_id: str, member_id: str = "1") -> bool:
    from app.services.issue_assignments import issue_assignment_service

    _, created = issue_assignment_service.record(
        db,
        project_id="project",
        issue_id=issue_id,
        member_type="user",
        member_id=member_id,
        assigned_by_user_id=1,
        workflow_step=None,
        notify=False,
        trigger="manual",
    )
    return created


def verify_independent_issues(engine: Engine) -> None:
    """Both absent history reads must finish before either comment is inserted."""
    ready = Barrier(2, timeout=10)

    def synchronize(connection, cursor, statement, parameters, context, many):
        if (
            statement.startswith("SELECT")
            and "loop_items.loop_item_id IN" in statement
            and "FOR UPDATE" in statement
            and not connection.info.get("assignment_barrier_entered")
        ):
            connection.info["assignment_barrier_entered"] = True
            ready.wait()

    def assign(index: int) -> bool:
        with Session(engine) as db:
            created = record(db, f"independent-{index}")
            db.commit()
            return created

    event.listen(engine, "after_cursor_execute", synchronize)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(assign, index) for index in range(2)]
            assert [future.result(timeout=20) for future in futures] == [True, True]
    finally:
        event.remove(engine, "after_cursor_execute", synchronize)
    print("MySQL: independent Issue assignments commit without gap-lock deadlocks")


def verify_same_issue(engine: Engine) -> None:
    """Pre-lock snapshots cannot duplicate an assignment of the same member."""
    from app.models.user import User
    from app.services.issue_assignments import issue_assignment_service

    ready = Barrier(2, timeout=10)

    def assign() -> bool:
        with Session(engine) as db:
            assert db.query(User.id).filter_by(id=1).scalar() == 1
            ready.wait()
            created = record(db, "shared")
            db.commit()
            return created

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(assign) for _ in range(2)]
        assert sorted(future.result(timeout=20) for future in futures) == [False, True]
    with Session(engine) as db:
        assignments = issue_assignment_service.active_for_issue(db, "shared")
        assert len(assignments) == 1
        assert assignments[0].member_id == "1"
    print("MySQL: the Issue row lock preserves assignment deduplication")


def verify_reassignment_and_rollback(engine: Engine) -> None:
    """A pre-existing snapshot sees committed reassignment; rollback preserves it."""
    from app.models.delivery import LoopItemActiveAssignment, LoopItemComment
    from app.models.user import User
    from app.services.issue_assignments import issue_assignment_service

    with Session(engine) as first:
        assert first.query(User.id).filter_by(id=1).scalar() == 1
        with Session(engine) as second:
            assert record(second, "shared", "2")
            second.commit()
        assert record(first, "shared", "1")
        first.commit()
    with Session(engine) as db:
        assignments = issue_assignment_service.active_for_issue(db, "shared")
        assert len(assignments) == 1
        assert assignments[0].member_id == "1"
        original_event = assignments[0].id
        original_count = db.query(LoopItemComment).count()
        assert record(db, "shared", "2")
        db.rollback()
    with Session(engine) as db:
        assignments = issue_assignment_service.active_for_issue(db, "shared")
        assert [assignment.id for assignment in assignments] == [original_event]
        assert db.query(LoopItemComment).count() == original_count
        index = db.query(LoopItemActiveAssignment).filter_by(parent_id="shared").all()
        assert sorted(row.loop_item_id for row in index if row.loop_item_id) == [
            original_event
        ]
    print("MySQL: reassignment stays current and rollback retains events and index")


async def verify_async_isolation() -> None:
    from app.db.session import get_async_engine

    engine = get_async_engine()
    try:
        async with engine.connect() as connection:
            result = await connection.exec_driver_sql("SELECT @@transaction_isolation")
            assert result.scalar_one() == "READ-COMMITTED"
    finally:
        await engine.dispose()
    print("MySQL: the asynchronous engine uses the same committed-read policy")


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
    created = False
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f"CREATE DATABASE `{database}`")
            created = True
        # Configure before importing application modules so both real factories run.
        os.environ["DATABASE_URL"] = url.set(database=database).render_as_string(
            hide_password=False
        )
        from app.db.session import engine

        seed(engine)
        verify_independent_issues(engine)
        verify_same_issue(engine)
        verify_reassignment_and_rollback(engine)
        with engine.connect() as connection:
            assert (
                connection.exec_driver_sql(
                    "SELECT @@transaction_isolation"
                ).scalar_one()
                == "READ-COMMITTED"
            )
        asyncio.run(verify_async_isolation())
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as connection:
                connection.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
