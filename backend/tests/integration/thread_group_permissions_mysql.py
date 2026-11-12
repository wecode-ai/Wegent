"""Group write/revocation serialization using real MySQL lock-wait evidence."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session


def _seed(engine: Engine, group_id: str, thread_id: str) -> None:
    from app.models.delivery import CollaborationChatGroup, LoopItem
    from app.models.project_chat_message import ProjectChatMessage
    from app.models.resource_member import ResourceMember
    from app.models.user import User
    from app.models.wework_notification import WeworkNotification
    from app.services.thread_participation import initialize_thread_participants

    ResourceMember.__table__.create(engine, checkfirst=True)
    WeworkNotification.__table__.create(engine, checkfirst=True)
    ProjectChatMessage.__table__.create(engine, checkfirst=True)
    with Session(engine) as db:
        for actor_id in (1, 2):
            actor = db.get(User, actor_id)
            assert actor is not None
            actor.is_active = True
        db.add(
            CollaborationChatGroup(
                id=group_id,
                name="Revocation transaction",
                status="active",
                created_by_user_id=1,
                metadata_json={"task_provider": "local"},
            )
        )
        db.add_all(
            ResourceMember(
                resource_type="CollaborationChatGroup",
                resource_id=int(group_id),
                entity_type="user",
                entity_id=str(actor_id),
                user_id=actor_id,
                role=role,
                status="approved",
            )
            for actor_id, role in ((1, "Owner"), (2, "Developer"))
        )
        db.flush()
        thread = LoopItem(
            id=thread_id,
            cloud_project_id=group_id,
            title="Review",
            status="pending",
            created_by_user_id=1,
            assignee_user_id=2,
        )
        db.add(thread)
        db.flush()
        initialize_thread_participants(db, thread)
        db.commit()


def _wait_for_database_lock(
    engine: Engine, connections: dict[str, int], waiting: str
) -> None:
    deadline = monotonic() + 10
    with engine.connect() as connection:
        while monotonic() < deadline:
            if len(connections) != 2:
                Event().wait(0.01)
                continue
            count = connection.execute(
                text(
                    "SELECT COUNT(*) FROM performance_schema.data_lock_waits w "
                    "JOIN performance_schema.threads waiter ON waiter.THREAD_ID=w.REQUESTING_THREAD_ID "
                    "JOIN performance_schema.threads holder ON holder.THREAD_ID=w.BLOCKING_THREAD_ID "
                    "JOIN performance_schema.data_locks requested ON requested.ENGINE=w.ENGINE "
                    "AND requested.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID "
                    "WHERE waiter.PROCESSLIST_ID=:waiting AND holder.PROCESSLIST_ID=:holding "
                    "AND requested.OBJECT_SCHEMA=:schema AND requested.OBJECT_NAME='loop_items' "
                    "AND requested.INDEX_NAME='PRIMARY'"
                ),
                {
                    "waiting": connections[waiting],
                    "holding": connections[
                        "writer" if waiting == "revoker" else "revoker"
                    ],
                    "schema": engine.url.database,
                },
            ).scalar_one()
            if count:
                return
            Event().wait(0.01)
    raise AssertionError("MySQL did not observe the competing group-row lock")


def _revoke(db: Session, group_id: str, thread_id: str, mode: str) -> None:
    from app.models.delivery import CollaborationChatGroup, ThreadParticipant
    from app.models.resource_member import ResourceMember

    group = (
        db.query(CollaborationChatGroup).filter_by(id=group_id).with_for_update().one()
    )
    grant = (
        db.query(ResourceMember)
        .filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group_id),
            entity_type="user",
            entity_id="2",
        )
        .one()
    )
    if mode == "remove":
        db.delete(grant)
    elif mode == "downgrade":
        grant.role = "Viewer"
    elif mode == "archive":
        group.status = "archived"
    elif mode == "leave":
        db.query(ThreadParticipant).filter_by(
            parent_id=thread_id, user_id=2
        ).one().status = "left"
    else:
        raise AssertionError(f"Unknown revocation mode: {mode}")
    db.flush()


def _verify_order(engine: Engine, mode: str, writer_first: bool, index: int) -> None:
    from app.models.project_chat_message import ProjectChatMessage
    from app.models.wework_notification import WeworkNotification
    from app.services.loop_items.service import loop_item_service

    group_id, thread_id = str(9900000 + index), f"GROUP-REVOKE-{index}"
    _seed(engine, group_id, thread_id)
    locked, release = Event(), Event()
    connections: dict[str, int] = {}

    def pause_after_grant_lock(
        connection, cursor, statement, parameters, context, many
    ):
        if (
            writer_first
            and connection.info.get("group_permission_writer")
            and statement.startswith("SELECT")
            and "resource_members" in statement
            and "FOR UPDATE" in statement
            and not locked.is_set()
        ):
            locked.set()
            assert release.wait(15), "Writer lock checkpoint was not released"

    def write() -> str | int:
        with engine.connect() as connection, Session(bind=connection) as db:
            connections["writer"] = int(
                db.execute(text("SELECT CONNECTION_ID()")).scalar_one()
            )
            connection.info["group_permission_writer"] = True
            try:
                loop_item_service.add_comment(db, thread_id, 2, "Authorized discussion")
                return "written"
            except HTTPException as exc:
                db.rollback()
                return exc.status_code
            finally:
                connection.info.pop("group_permission_writer", None)

    def revoke() -> None:
        with Session(engine) as db:
            connections["revoker"] = int(
                db.execute(text("SELECT CONNECTION_ID()")).scalar_one()
            )
            _revoke(db, group_id, thread_id, mode)
            if not writer_first:
                locked.set()
                assert release.wait(15), "Revocation lock checkpoint was not released"
            db.commit()

    event.listen(engine, "after_cursor_execute", pause_after_grant_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(write if writer_first else revoke)
            assert locked.wait(
                10
            ), "The first transaction did not acquire current authority"
            second = pool.submit(revoke if writer_first else write)
            try:
                _wait_for_database_lock(
                    engine, connections, "revoker" if writer_first else "writer"
                )
            finally:
                release.set()
            write_result = (first if writer_first else second).result(timeout=20)
            (second if writer_first else first).result(timeout=20)
        expected = (
            "written"
            if writer_first
            else {
                "remove": 404,
                "downgrade": 403,
                "leave": 403,
                "archive": 409,
            }[mode]
        )
        assert write_result == expected, (mode, writer_first, write_result)
        with Session(engine) as db:
            assert db.query(ProjectChatMessage).filter_by(
                project_id=group_id, task_id=thread_id, sender_type="user"
            ).count() == int(writer_first)
            assert db.query(WeworkNotification).filter(
                WeworkNotification.payload["itemId"].as_string() == thread_id
            ).count() == int(writer_first)
        print(
            f"MySQL group {mode}: {'write' if writer_first else 'revocation'} committed first"
        )
    finally:
        release.set()
        event.remove(engine, "after_cursor_execute", pause_after_grant_lock)


def verify_group_write_revocation(engine: Engine) -> None:
    """Reuse the CI-owned temporary schema and application's READ COMMITTED engine."""
    with engine.connect() as connection:
        assert (
            connection.exec_driver_sql("SELECT @@transaction_isolation").scalar_one()
            == "READ-COMMITTED"
        )
    for index, (mode, writer_first) in enumerate(
        (mode, writer_first)
        for mode in ("remove", "downgrade", "leave", "archive")
        for writer_first in (True, False)
    ):
        # Keep real persistence and commit scheduling; external delivery is a protocol double.
        with (
            patch(
                "app.services.wework_notifications.deliver_notification",
                new_callable=AsyncMock,
            ),
            patch("app.services.project_chat.push.push_project_chat_message"),
        ):
            _verify_order(engine, mode, writer_first, index)
