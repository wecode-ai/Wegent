"""Thread deletion and recipient changes must survive an older RR snapshot."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Event
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from tests.integration.thread_classification_mysql import _wait
from tests.integration.thread_group_permissions_mysql import _seed


def verify_group_current_facts(engine: Engine) -> None:
    from app.models.delivery import (
        CollaborationChatGroup,
        LoopItem,
        StandInIssueEvent,
        ThreadParticipant,
    )
    from app.models.resource_member import ResourceMember
    from app.models.user import User
    from app.models.wework_notification import WeworkNotification
    from app.schemas.base_role import BaseRole
    from app.schemas.project_chat import ProjectChatSend
    from app.services.delivery.access import require_loop_item_access
    from app.services.project_chat.service import project_chat_service

    for index, mode in enumerate(
        (
            "deleted_chat",
            "deleted_delivery",
            "left",
            "muted",
            "removed",
            "inactive",
            "joined",
            "unmuted",
            "approved",
        )
    ):
        group_id, thread_id = str(9960000 + index), f"GROUP-CURRENT-{index}"
        _seed(engine, group_id, thread_id)
        if mode in {"joined", "unmuted", "approved"}:
            with Session(engine) as db:
                participant = (
                    db.query(ThreadParticipant)
                    .filter_by(parent_id=thread_id, user_id=2)
                    .one()
                )
                if mode == "joined":
                    participant.status = "left"
                elif mode == "unmuted":
                    participant.metadata_json = {"notifications": "muted"}
                else:
                    db.query(ResourceMember).filter_by(
                        resource_type="CollaborationChatGroup",
                        resource_id=int(group_id),
                        entity_type="user",
                        entity_id="2",
                    ).one().status = "pending"
                db.commit()
        locked, release = Event(), Event()
        ids: dict[str, int] = {}

        def revoke() -> None:
            with Session(engine) as db:
                db.execute(text("SET SESSION innodb_lock_wait_timeout=15"))
                ids["revoker"] = db.execute(text("SELECT CONNECTION_ID()")).scalar_one()
                db.query(CollaborationChatGroup).filter_by(
                    id=group_id
                ).with_for_update().one()
                if mode.startswith("deleted"):
                    db.get(LoopItem, thread_id).deleted_at = datetime.utcnow()
                elif mode in {"left", "muted", "joined", "unmuted"}:
                    row = (
                        db.query(ThreadParticipant)
                        .filter_by(parent_id=thread_id, user_id=2)
                        .one()
                    )
                    if mode in {"left", "joined"}:
                        row.status = "left" if mode == "left" else "active"
                    else:
                        row.metadata_json = {
                            "notifications": "muted" if mode == "muted" else "all"
                        }
                elif mode == "approved":
                    db.query(ResourceMember).filter_by(
                        resource_type="CollaborationChatGroup",
                        resource_id=int(group_id),
                        entity_type="user",
                        entity_id="2",
                    ).one().status = "approved"
                elif mode == "removed":
                    db.query(ResourceMember).filter_by(
                        resource_type="CollaborationChatGroup",
                        resource_id=int(group_id),
                        entity_type="user",
                        entity_id="2",
                    ).delete()
                else:
                    db.get(User, 2).is_active = False
                db.flush()
                locked.set()
                assert release.wait(
                    15
                ), "Current-facts revocation barrier was not released"
                db.commit()

        def write() -> int:
            with engine.connect().execution_options(
                isolation_level="REPEATABLE READ"
            ) as connection:
                with Session(bind=connection) as db:
                    db.execute(text("SET SESSION innodb_lock_wait_timeout=15"))
                    ids["writer"] = db.execute(
                        text("SELECT CONNECTION_ID()")
                    ).scalar_one()
                    assert db.get(LoopItem, thread_id).deleted_at is None
                    try:
                        if mode == "deleted_delivery":
                            require_loop_item_access(
                                db, thread_id, 1, BaseRole.Developer
                            )
                            db.commit()
                        else:
                            project_chat_service.send(
                                db,
                                user_id=1,
                                user_name="Owner",
                                request=ProjectChatSend(
                                    project_id=group_id,
                                    task_id=thread_id,
                                    client_message_id=f"current-{index}",
                                    content="Current-facts message",
                                    mentions=(
                                        []
                                        if mode.startswith("deleted")
                                        else [
                                            {
                                                "type": "user",
                                                "id": "2",
                                                "label": "Member",
                                            },
                                        ]
                                    ),
                                ),
                            )
                        return 200
                    except HTTPException as exc:
                        db.rollback()
                        return exc.status_code

        with (
            patch(
                "app.services.wework_notifications.deliver_notification",
                new_callable=AsyncMock,
            ),
            patch("app.services.project_chat.push.push_project_chat_message"),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            revoker = pool.submit(revoke)
            assert locked.wait(10), "Revoker did not establish current-facts barrier"
            writer = pool.submit(write)
            try:
                _wait(engine, ids, "writer", writer)
            finally:
                release.set()
            revoker.result(timeout=20)
            result = writer.result(timeout=20)
        if mode.startswith("deleted"):
            assert result == 404, (mode, result)
        else:
            assert result in {200, 409, 422}, (mode, result)
            with Session(engine) as db:
                assert db.query(WeworkNotification).filter(
                    WeworkNotification.payload["itemId"].as_string() == thread_id
                ).count() == int(mode in {"joined", "unmuted", "approved"}), mode
                assert db.query(StandInIssueEvent).filter(
                    StandInIssueEvent.metadata_json["itemId"].as_string() == thread_id
                ).count() == int(
                    mode in {"muted", "joined", "unmuted", "approved"}
                ), mode
        print(f"MySQL group current-facts RR: {mode} passed", flush=True)
