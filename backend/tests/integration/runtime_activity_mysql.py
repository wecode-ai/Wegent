"""CI-covered MySQL checks for concurrent Runtime activity projection."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session

from app.models.project_chat_message import ProjectChatMessage
from app.services.project_chat.service import project_chat_service


def verify_independent_runtime_tasks(engine: Engine) -> None:
    """Absent runtime events must not gap-lock another task's first activity."""
    ready = Barrier(2, timeout=10)

    def open_activity(index: int) -> None:
        task_id = f"member-{index}"
        with Session(engine, autoflush=False) as db:
            assert (
                project_chat_service._streaming_activity_for_runtime(
                    db,
                    "runtime-device",
                    task_id,
                    device_ids=["runtime-device", "app-record-1"],
                )
                is None
            )
            ready.wait()
            db.add(
                ProjectChatMessage(
                    message_id=task_id,
                    client_message_id=task_id,
                    project_id="project-1",
                    task_id="ISSUE-1",
                    sender_type="agent",
                    sender_id=task_id,
                    runtime_device_id="runtime-device",
                    runtime_task_id=task_id,
                    status="streaming",
                    content="",
                )
            )
            db.commit()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(open_activity, index) for index in range(2)]
        for future in futures:
            future.result(timeout=20)
    with Session(engine) as db:
        assert db.query(ProjectChatMessage).count() == 2
    print("MySQL: independent first activities persist without absent-row gap locks")


def verify_existing_activity_serialization(engine: Engine) -> None:
    """Concurrent stream updates must still read the row after its owner commits."""
    ready = Barrier(2, timeout=10)

    def append_result(value: str) -> None:
        with Session(engine, autoflush=False) as db:
            # Establish the same pre-lock snapshot used by request authorization.
            previous = (
                db.query(ProjectChatMessage).filter_by(message_id="member-0").one()
            )
            ready.wait()
            row = project_chat_service._streaming_activity_for_runtime(
                db, "runtime-device", "member-0"
            )
            assert row is not None
            assert row.id == previous.id
            row.content += value
            db.commit()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(append_result, value) for value in ("A", "B")]
        for future in futures:
            future.result(timeout=20)
    with Session(engine) as db:
        row = db.query(ProjectChatMessage).filter_by(message_id="member-0").one()
        assert row.content in {"AB", "BA"}, row.content
    print("MySQL: existing stream updates retain row serialization and both results")


def main() -> None:
    url = make_url(os.environ["RUNTIME_ACTIVITY_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("Only an explicitly configured local/CI MySQL is allowed")
    database = "test_runtime_activity_" + uuid.uuid4().hex
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
        ProjectChatMessage.__table__.create(engine)
        verify_independent_runtime_tasks(engine)
        verify_existing_activity_serialization(engine)
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as connection:
                connection.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
