"""Explicit CI-only MySQL transaction check; run by e2e-tests.yml, never skipped."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier, Event
from typing import Any

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, ExceptionContext, make_url
from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.services.dingtalk_doc_service import DingTalkDocService


def verify_transactions(engine: Engine) -> None:
    """Force both snapshots to see absence, then commit the winner first."""
    now = datetime(2026, 8, 28, 16, 0, 0)
    old = {"nodeId": "old", "name": "Old", "nodeType": "folder"}
    shared = {"nodeId": "new", "name": "New", "nodeType": "folder"}
    barrier = Barrier(2, timeout=10)
    winner_done = Event()
    errors = []

    @event.listens_for(engine, "handle_error")
    def record_database_error(context: ExceptionContext) -> None:
        errors.append(context.original_exception.args[0])

    with Session(engine, autoflush=False) as db:
        DingTalkDocService._sync_nodes_to_db(1, [old], now, db)

    def sync(winner: bool) -> dict[str, Any]:
        with Session(engine, autoflush=False) as db:

            @event.listens_for(db, "before_commit", once=True)
            def synchronize(_session: Session) -> None:
                barrier.wait()
                if not winner and not winner_done.wait(15):
                    raise TimeoutError("Winning transaction did not finish")

            nodes = (
                [old, shared] if winner else [shared, {**old, "nodeId": "loser-only"}]
            )
            try:
                return DingTalkDocService._sync_nodes_to_db(1, nodes, now, db)
            finally:
                if winner:
                    winner_done.set()

    with ThreadPoolExecutor(max_workers=2) as workers:
        winning = workers.submit(sync, True)
        losing = workers.submit(sync, False)
        assert winning.result(timeout=30)["added"] == 1
        try:
            losing.result(timeout=30)
        except RuntimeError as exc:
            assert str(exc) == "Failed to persist DingTalk directory nodes"
        else:
            raise AssertionError("The conflicting transaction must fail")

    assert errors == [1062], errors
    with Session(engine) as db:
        rows = db.query(DingtalkSyncedNode).all()
        assert {row.dingtalk_node_id for row in rows} == {"old", "new"}
        assert all(
            row.is_active for row in rows
        ), "The loser's deactivation must roll back"
    print(
        "MySQL: duplicate insert rejected, all losing transaction changes rolled back"
    )


def main() -> None:
    url = make_url(os.environ["DINGTALK_SYNC_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError(
            "Only an explicitly configured local/CI MySQL service is allowed"
        )
    database = "test_dingtalk_sync_" + uuid.uuid4().hex
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
        DingtalkSyncedNode.__table__.create(engine)
        verify_transactions(engine)
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as connection:
                connection.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
