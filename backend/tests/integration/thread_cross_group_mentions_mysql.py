"""Mutual cross-group mentions acquire account locks in the same order."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import AsyncMock, patch

from sqlalchemy import event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from tests.integration.thread_classification_mysql import _wait
from tests.integration.thread_group_permissions_mysql import _seed


def verify_cross_group_mentions(engine: Engine) -> None:
    from app.models.delivery import LoopItem, StandInIssueEvent, ThreadParticipant
    from app.models.project_chat_message import ProjectChatMessage
    from app.schemas.project_chat import ProjectChatSend
    from app.services.project_chat.service import project_chat_service

    for index, (isolation, mode) in enumerate(
        (isolation, mode)
        for isolation in ("READ COMMITTED", "REPEATABLE READ")
        for mode in ("explicit", "implicit", "assignment")
    ):
        pairs = [
            (str(9970000 + index * 2 + n), f"GROUP-MUTUAL-{index}-{n}")
            for n in range(2)
        ]
        for group_id, thread_id in pairs:
            _seed(engine, group_id, thread_id)
        with Session(engine) as db:
            for _, thread_id in pairs:
                thread = db.get(LoopItem, thread_id)
                thread.sequence_number = 1
                thread.priority = "none"
            db.commit()
        if mode == "implicit":
            with Session(engine) as db:
                for position, (group_id, thread_id) in enumerate(pairs):
                    for participant in db.query(ThreadParticipant).filter_by(
                        parent_id=thread_id
                    ):
                        participant.metadata_json = {"notifications": "muted"}
                    db.add(
                        ProjectChatMessage(
                            message_id=f"mutual-source-{index}-{position}",
                            project_id=group_id,
                            task_id=thread_id,
                            sender_type="agent",
                            sender_id=f"stand-in:{2 - position}",
                            sender_name="Muted stand-in",
                            content="Persisted public reply",
                            metadata_json={
                                "stand_in": {
                                    "user_id": 2 - position,
                                    "role_id": "primary",
                                },
                            },
                        )
                    )
                db.commit()
        locked, release = Event(), Event()
        ids: dict[str, int] = {}

        def pause(connection, cursor, statement, parameters, context, many):
            if (
                connection.info.get("mutual_first_actor")
                and "FROM users" in statement
                and "FOR UPDATE" in statement
                and not locked.is_set()
            ):
                locked.set()
                assert release.wait(15), "First account lock was not released"

        def send(position: int) -> None:
            actor = position + 1
            group_id, thread_id = pairs[position]
            with engine.connect().execution_options(
                isolation_level=isolation
            ) as connection:
                with Session(bind=connection) as db:
                    db.execute(text("SET SESSION innodb_lock_wait_timeout=15"))
                    ids["writer" if position == 0 else "revoker"] = db.execute(
                        text("SELECT CONNECTION_ID()")
                    ).scalar_one()
                    connection.info["mutual_first_actor"] = position == 0
                    try:
                        if mode == "assignment":
                            from fastapi import BackgroundTasks

                            from app.api.endpoints.deliveries import (
                                create_issue_assignment,
                            )
                            from app.models.user import User
                            from app.schemas.issue_assignment import (
                                IssueAssignmentCreate,
                            )

                            asyncio.run(
                                create_issue_assignment(
                                    item_id=thread_id,
                                    values=IssueAssignmentCreate(
                                        target_type="human",
                                        target_id=str(3 - actor),
                                        comment_body="Assign with discussion",
                                        notify_target=False,
                                    ),
                                    background_tasks=BackgroundTasks(),
                                    db=db,
                                    current_user=db.get(User, actor),
                                )
                            )
                            return
                        request = ProjectChatSend(
                            project_id=group_id,
                            task_id=thread_id,
                            client_message_id=f"mutual-{index}-{actor}",
                            content="Mutual group mention",
                            mentions=(
                                [
                                    {
                                        "type": "user",
                                        "id": str(3 - actor),
                                        "label": "Other member",
                                    }
                                ]
                                if mode == "explicit"
                                else []
                            ),
                            reply_to_message_id=(
                                f"mutual-source-{index}-{position}"
                                if mode == "implicit"
                                else None
                            ),
                        )
                        project_chat_service.send(
                            db,
                            user_id=actor,
                            user_name=f"Actor {actor}",
                            request=request,
                        )
                        # A committed retry must preserve both message and wakeup identity.
                        again = project_chat_service.send(
                            db,
                            user_id=actor,
                            user_name=f"Actor {actor}",
                            request=request,
                        )
                        assert not again.created
                        db.commit()
                    finally:
                        connection.info.pop("mutual_first_actor", None)

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
                first = pool.submit(send, 0)
                assert locked.wait(10), "First sender did not lock its account set"
                second = pool.submit(send, 1)
                try:
                    _wait(engine, ids, "revoker", second)
                finally:
                    release.set()
                first.result(timeout=20)
                second.result(timeout=20)
            with Session(engine) as db:
                for group_id, thread_id in pairs:
                    assert (
                        db.query(ProjectChatMessage)
                        .filter_by(
                            project_id=group_id, task_id=thread_id, sender_type="user"
                        )
                        .count()
                        == 1
                    )
                    if mode != "assignment":
                        assert (
                            db.query(StandInIssueEvent)
                            .filter(
                                StandInIssueEvent.metadata_json["itemId"].as_string()
                                == thread_id
                            )
                            .count()
                            == 1
                        )
                    else:
                        from app.services.issue_assignments import (
                            issue_assignment_service,
                        )

                        assert (
                            issue_assignment_service.active(
                                db,
                                issue_id=thread_id,
                                member_type="human",
                                member_id=str(2 if group_id == pairs[0][0] else 1),
                                workflow_step=None,
                            )
                            is not None
                        )
            print(f"MySQL cross-group {mode}: {isolation} passed", flush=True)
        finally:
            release.set()
            event.remove(engine, "after_cursor_execute", pause)
