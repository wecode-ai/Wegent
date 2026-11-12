"""Real group discussion and private conversation reservation share lock order."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import AsyncMock, patch

from sqlalchemy import event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from tests.integration.thread_classification_mysql import _wait
from tests.integration.thread_group_permissions_mysql import _seed


def verify_group_conversation_binding(engine: Engine) -> None:
    from app.models.delivery import LoopItemTaskBinding
    from app.models.kind import Kind
    from app.models.project_chat_message import ProjectChatMessage
    from app.schemas.delivery import LoopItemTaskBind
    from app.services.loop_items.service import loop_item_service

    for index, isolation in enumerate(("READ COMMITTED", "REPEATABLE READ")):
        group_id, thread_id = str(9950000 + index), f"GROUP-BIND-{index}"
        _seed(engine, group_id, thread_id)
        device_id = f"group-binding-device-{index}"
        with Session(engine) as db:
            db.add(
                Kind(
                    kind="Device",
                    namespace="default",
                    name=device_id,
                    user_id=2,
                    is_active=True,
                    json={"spec": {"deviceType": "local"}},
                )
            )
            db.commit()
        locked, release = Event(), Event()
        connections: dict[str, int] = {}

        def pause(connection, cursor, statement, parameters, context, many):
            if (
                connection.info.get("binding_discussion")
                and "resource_members" in statement
                and "FOR UPDATE" in statement
                and not locked.is_set()
            ):
                locked.set()
                assert release.wait(15), "Discussion authority barrier was not released"

        def operation(bind: bool) -> None:
            with engine.connect().execution_options(
                isolation_level=isolation
            ) as connection:
                with Session(bind=connection) as db:
                    db.execute(text("SET SESSION innodb_lock_wait_timeout=15"))
                    connections["revoker" if bind else "writer"] = int(
                        db.execute(text("SELECT CONNECTION_ID()")).scalar_one()
                    )
                    connection.info["binding_discussion"] = not bind
                    try:
                        if bind:
                            loop_item_service.bind_task(
                                db,
                                thread_id,
                                LoopItemTaskBind(
                                    device_id=device_id,
                                    task_id=f"private-task-{index}",
                                    stand_in_conversation_id=f"private-conversation-{index}",
                                ),
                                2,
                            )
                        else:
                            loop_item_service.add_comment(
                                db, thread_id, 2, "Parallel discussion"
                            )
                    finally:
                        connection.info.pop("binding_discussion", None)

        event.listen(engine, "after_cursor_execute", pause)
        try:
            with (
                patch(
                    "app.services.wework_notifications.deliver_notification",
                    new_callable=AsyncMock,
                ),
                patch("app.services.project_chat.push.push_project_chat_message"),
                ThreadPoolExecutor(max_workers=2) as pool,
            ):
                discussion = pool.submit(operation, False)
                assert locked.wait(10), "Discussion did not lock group authority"
                binding = pool.submit(operation, True)
                try:
                    _wait(engine, connections, "revoker", binding)
                finally:
                    release.set()
                discussion.result(timeout=20)
                binding.result(timeout=20)
            with Session(engine) as db:
                assert (
                    db.query(LoopItemTaskBinding)
                    .filter_by(loop_item_id=thread_id)
                    .count()
                    == 1
                )
                assert (
                    db.query(ProjectChatMessage)
                    .filter_by(
                        project_id=group_id, task_id=thread_id, sender_type="user"
                    )
                    .count()
                    == 1
                )
            print(
                f"MySQL group discussion/binding shared lock order: {isolation}",
                flush=True,
            )
        finally:
            release.set()
            event.remove(engine, "after_cursor_execute", pause)


def verify_group_repeatable_read_revocation(engine: Engine) -> None:
    from tests.integration.thread_group_permissions_mysql import _verify_order

    current = engine.execution_options(isolation_level="REPEATABLE READ")
    with (
        patch(
            "app.services.wework_notifications.deliver_notification",
            new_callable=AsyncMock,
        ),
        patch("app.services.project_chat.push.push_project_chat_message"),
    ):
        for index, mode in enumerate(
            ("leave", "remove", "downgrade", "archive"), start=200
        ):
            _verify_order(current, mode, False, index)
