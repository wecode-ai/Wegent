"""Independent explicit resource grants must not take conflicting missing-key locks."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models.delivery import CollaborationChatGroup
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.services.chat_group_access import GROUP_RESOURCE_TYPE
from app.services.group_resource_permissions import authorize_group_team


def _seed(engine: Engine, actor: int) -> tuple[str, int]:
    with Session(engine) as db:
        group = CollaborationChatGroup(
            project_key=f"GRC{uuid4().hex[:12]}",
            name="Independent resource grants",
            created_by_user_id=actor,
        )
        team = Kind(
            kind="Team",
            namespace="default",
            name=f"Owned-{uuid4().hex}",
            user_id=actor,
            is_active=True,
            json={},
        )
        db.add_all([group, team])
        db.flush()
        db.add(
            ResourceMember(
                resource_type=GROUP_RESOURCE_TYPE,
                resource_id=int(group.id),
                entity_type="user",
                entity_id=str(actor),
                role="Owner",
                status="approved",
            )
        )
        result = str(group.id), team.id
        db.commit()
        return result


def run_independent_group_resource_grants(engine: Engine) -> None:
    owners = [(actor, *_seed(engine, actor)) for actor in (1, 2)]
    barrier = Barrier(2)

    def locked(connection, cursor, statement, parameters, context, many):
        if not connection.info.get("group_resource_writer") or connection.info.get(
            "grant_barrier_done"
        ):
            return
        if (
            statement.startswith("SELECT")
            and "resource_members" in statement
            and "FOR UPDATE" in statement
            and isinstance(parameters, dict)
            and "chat_group" in parameters.values()
        ):
            connection.info["grant_barrier_done"] = True
            barrier.wait(timeout=10)

    def grant(actor: int, group_id: str, team_id: int) -> None:
        with (
            engine.connect().execution_options(
                isolation_level="REPEATABLE READ"
            ) as connection,
            Session(bind=connection) as db,
        ):
            connection.info["group_resource_writer"] = True
            try:
                authorize_group_team(
                    db, db.get(CollaborationChatGroup, group_id), actor, team_id
                )
                db.commit()
            finally:
                connection.info.pop("group_resource_writer", None)
                connection.info.pop("grant_barrier_done", None)

    event.listen(engine, "after_cursor_execute", locked)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(grant, *row) for row in owners]
            for result in pending:
                result.result(timeout=20)
    finally:
        event.remove(engine, "after_cursor_execute", locked)
    with Session(engine) as db:
        for _, group_id, team_id in owners:
            row = (
                db.query(ResourceMember)
                .filter_by(
                    resource_type="Team",
                    resource_id=team_id,
                    entity_type="chat_group",
                    entity_id=group_id,
                )
                .one()
            )
            assert row.status == "approved"
    print("MySQL independent Group resource grants: both committed", flush=True)
