"""Real permission services race classified creation at observed MySQL locks."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session


def _seed(engine: Engine, index: int, mode: str) -> tuple[str, str, int]:
    from app.models.delivery import CloudProject, CollaborationChatGroup
    from app.models.kind import Kind
    from app.models.loop_item_execution import LoopItemExecution
    from app.models.project_chat_message import ProjectChatMessage
    from app.models.resource_member import ResourceMember
    from app.models.wework_notification import WeworkNotification

    for model in (LoopItemExecution, ProjectChatMessage, WeworkNotification):
        model.__table__.create(engine, checkfirst=True)
    project_id, group_id = str(810000 + index), str(820000 + index)
    with Session(engine) as db:
        workspace = Kind(
            kind="CollaborationWorkspace",
            namespace="default",
            name=f"classification-{index}",
            user_id=1,
            json={"spec": {}},
            is_active=True,
        )
        db.add(workspace)
        db.flush()
        db.add_all(
            [
                CloudProject(
                    id=project_id,
                    project_key=f"CLP{index}",
                    name="Classification",
                    status="active",
                    created_by_user_id=1,
                ),
                CollaborationChatGroup(
                    id=group_id,
                    project_key=f"CLG{index}",
                    name="Owning group",
                    status="active",
                    created_by_user_id=2,
                ),
            ]
        )
        db.flush()
        for kind, resource, entity_type, entity, role in [
            (
                "CloudProject",
                int(project_id),
                "workspace",
                str(workspace.id),
                "Maintainer",
            ),
            ("CollaborationChatGroup", int(group_id), "user", "2", "Owner"),
            (
                "Workspace" if mode.startswith("inherited") else "CloudProject",
                workspace.id if mode.startswith("inherited") else int(project_id),
                "user",
                "2",
                "Developer",
            ),
        ]:
            db.add(
                ResourceMember(
                    resource_type=kind,
                    resource_id=resource,
                    entity_type=entity_type,
                    entity_id=entity,
                    user_id=1,
                    role=role,
                    status="approved",
                )
            )
        workspace_id = workspace.id
        db.commit()
    return project_id, group_id, workspace_id


def _wait(engine: Engine, ids: dict[str, int], waiting: str, operation) -> None:
    deadline = monotonic() + 10
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as db:
        while monotonic() < deadline:
            if operation.done():
                result = operation.result()
                raise AssertionError(
                    f"The competing operation finished before its lock barrier: {result!r}"
                )
            if len(ids) == 2:
                row = db.execute(
                    text(
                        "SELECT requested.OBJECT_NAME,requested.INDEX_NAME,w.REQUESTING_ENGINE_TRANSACTION_ID,w.BLOCKING_ENGINE_TRANSACTION_ID FROM performance_schema.data_lock_waits w "
                        "JOIN information_schema.innodb_trx a ON a.trx_id=w.REQUESTING_ENGINE_TRANSACTION_ID "
                        "JOIN information_schema.innodb_trx b ON b.trx_id=w.BLOCKING_ENGINE_TRANSACTION_ID "
                        "JOIN performance_schema.data_locks requested ON requested.ENGINE=w.ENGINE "
                        "AND requested.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID "
                        "WHERE a.trx_mysql_thread_id=:waiting AND b.trx_mysql_thread_id=:holding "
                        "AND requested.OBJECT_SCHEMA=:schema AND requested.OBJECT_NAME IN ('loop_items','resource_members','kinds','users')"
                    ),
                    {
                        "waiting": ids[waiting],
                        "holding": ids["revoker" if waiting == "writer" else "writer"],
                        "schema": engine.url.database,
                    },
                ).first()
                if row:
                    print(
                        f"MySQL classification barrier: {ids}, waiting={waiting}, lock={tuple(row)}",
                        flush=True,
                    )
                    return
            # MySQL 8.0 refreshes INNODB_TRX only after 100 ms without reads.
            # Faster polling indefinitely preserves the preceding case's cache.
            # mysql/mysql-server mysql-8.0.21: trx0i_s.cc CACHE_MIN_IDLE_TIME_US.
            Event().wait(0.2)
        details = db.execute(
            text(
                "SELECT a.PROCESSLIST_ID,b.PROCESSLIST_ID,l.OBJECT_SCHEMA,l.OBJECT_NAME,l.INDEX_NAME,l.LOCK_DATA, "
                "w.REQUESTING_ENGINE_TRANSACTION_ID,w.BLOCKING_ENGINE_TRANSACTION_ID,ta.trx_mysql_thread_id,tb.trx_mysql_thread_id "
                "FROM performance_schema.data_lock_waits w "
                "JOIN performance_schema.threads a ON a.THREAD_ID=w.REQUESTING_THREAD_ID "
                "JOIN performance_schema.threads b ON b.THREAD_ID=w.BLOCKING_THREAD_ID "
                "JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID "
                "LEFT JOIN information_schema.innodb_trx ta ON ta.trx_id=w.REQUESTING_ENGINE_TRANSACTION_ID "
                "LEFT JOIN information_schema.innodb_trx tb ON tb.trx_id=w.BLOCKING_ENGINE_TRANSACTION_ID "
                "WHERE a.PROCESSLIST_ID=:waiting OR b.PROCESSLIST_ID=:holding"
            ),
            {
                "waiting": ids.get(waiting),
                "holding": ids.get("revoker" if waiting == "writer" else "writer"),
            },
        ).all()
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as fresh:
        transactions = fresh.execute(
            text(
                "SELECT trx_id,trx_mysql_thread_id,trx_state FROM information_schema.innodb_trx"
            )
        ).all()
        fresh_waits = fresh.execute(
            text(
                "SELECT w.REQUESTING_ENGINE_TRANSACTION_ID,w.BLOCKING_ENGINE_TRANSACTION_ID,ta.trx_mysql_thread_id,tb.trx_mysql_thread_id,l.OBJECT_NAME "
                "FROM performance_schema.data_lock_waits w "
                "JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID "
                "LEFT JOIN information_schema.innodb_trx ta ON ta.trx_id=w.REQUESTING_ENGINE_TRANSACTION_ID "
                "LEFT JOIN information_schema.innodb_trx tb ON tb.trx_id=w.BLOCKING_ENGINE_TRANSACTION_ID "
                "WHERE l.OBJECT_SCHEMA=:schema"
            ),
            {"schema": engine.url.database},
        ).all()
    raise AssertionError(
        f"No expected classification lock wait: ids={ids}, actual={details}, fresh_transactions={transactions}, fresh_waits={fresh_waits}"
    )


def _case(engine: Engine, index: int, mode: str, writer_first: bool) -> None:
    from app.models.delivery import CollaborationChatGroup, LoopItem, ThreadProjectLink
    from app.schemas.base_role import BaseRole
    from app.schemas.cloud_project import CloudProjectMemberUpdate
    from app.schemas.delivery import LoopItemCreate
    from app.schemas.workspace import WorkspaceMemberUpdate
    from app.services.cloud_projects import cloud_project_service
    from app.services.loop_items.service import loop_item_service
    from app.services.workspaces import workspace_service

    project, group, workspace = _seed(engine, index, mode)
    locked, release = Event(), Event()
    ids: dict[str, int] = {}

    def pause(_db):
        locked.set()
        assert release.wait(15), "Classification commit checkpoint was not released"

    def write():
        with Session(engine) as db:
            db.execute(text("SET SESSION innodb_lock_wait_timeout=15"))
            ids["writer"] = db.execute(text("SELECT CONNECTION_ID()")).scalar_one()
            if writer_first:
                event.listen(db, "before_commit", pause)
            try:
                item = loop_item_service.create(
                    db,
                    group,
                    2,
                    LoopItemCreate(
                        title="Classified atomically",
                        classification_project_id=project,
                        notify_assignee=False,
                    ),
                    commit=False,
                )
                db.commit()
                return item.id
            except HTTPException as denied:
                db.rollback()
                return denied.status_code

    def revoke():
        with Session(engine) as db:
            db.execute(text("SET SESSION innodb_lock_wait_timeout=15"))
            ids["revoker"] = db.execute(text("SELECT CONNECTION_ID()")).scalar_one()
            if not writer_first:
                event.listen(db, "before_commit", pause)
            if mode == "direct_remove":
                cloud_project_service.remove_member(db, int(project), 2, 1)
            elif mode == "direct_downgrade":
                cloud_project_service.update_member(
                    db,
                    int(project),
                    2,
                    1,
                    CloudProjectMemberUpdate(role=BaseRole.Viewer),
                )
            elif mode == "inherited_remove":
                workspace_service.remove_member(db, workspace, 2, 1)
            else:
                workspace_service.update_member(
                    db, workspace, 2, 1, WorkspaceMemberUpdate(role=BaseRole.Viewer)
                )

    with (
        patch("app.services.project_chat.push.push_project_chat_message"),
        patch(
            "app.services.wework_notifications.deliver_notification",
            new_callable=AsyncMock,
        ),
    ):
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(write if writer_first else revoke)
            assert locked.wait(
                10
            ), "The first classification operation did not reach its commit checkpoint"
            second = pool.submit(revoke if writer_first else write)
            try:
                _wait(engine, ids, "revoker" if writer_first else "writer", second)
            finally:
                release.set()
            result = first.result() if writer_first else second.result()
            (second if writer_first else first).result()
    with Session(engine) as db:
        items = db.query(LoopItem).filter_by(cloud_project_id=group).all()
        links = (
            db.query(ThreadProjectLink)
            .filter_by(parent_id=project, status="active")
            .all()
        )
        current = db.get(CollaborationChatGroup, group)
        if writer_first:
            assert isinstance(result, str) and [item.id for item in items] == [result]
            assert len(links) == 1 and links[0].loop_item_id == result
            assert current.next_item_number == 2
        else:
            assert result in (403, 404), result
            assert items == [] and links == [] and current.next_item_number == 1
    print(
        f"MySQL classified creation: {mode}, writer_first={writer_first} passed",
        flush=True,
    )


def verify_thread_classification(engine: Engine) -> None:
    index = 0
    for isolation in ("READ COMMITTED", "REPEATABLE READ"):
        for mode in (
            "direct_remove",
            "direct_downgrade",
            "inherited_remove",
            "inherited_downgrade",
        ):
            for writer_first in (False, True):
                index += 1
                _case(
                    engine.execution_options(isolation_level=isolation),
                    index,
                    mode,
                    writer_first,
                )
