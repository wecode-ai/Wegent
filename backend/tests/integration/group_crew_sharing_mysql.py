"""Source authority revocation prevents a new group crew grant under real locks."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

from fastapi import HTTPException
from sqlalchemy import event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from tests.integration.thread_classification_mysql import _seed, _wait


def _prepare(engine: Engine, index: int, source: str):
    from app.models.resource_member import ResourceMember
    from app.models.user import User
    from app.schemas.workspace import CollaborationGroupCreate, CollaborationGroupMember
    from app.services.workspaces import workspace_service

    project, group, workspace = _seed(
        engine, index, "inherited_crew" if source == "workspace" else "direct_crew"
    )
    source_id = workspace if source == "workspace" else int(project)
    with Session(engine) as db:
        db.query(User).filter(User.id.in_([1, 2])).update({"is_active": True})
        grant = (
            db.query(ResourceMember)
            .filter_by(
                resource_type="Workspace" if source == "workspace" else "CloudProject",
                resource_id=source_id,
                entity_type="user",
                entity_id="2",
            )
            .one()
        )
        grant.role = "Maintainer"
        db.commit()
        human = CollaborationGroupMember(kind="human", id="2")
        values = CollaborationGroupCreate(
            name=f"Crew source {index}", leader=human, members=[human]
        )
        creator = (
            workspace_service.create_collaboration_group
            if source == "workspace"
            else workspace_service.create_project_collaboration_group
        )
        crew = creator(db, source_id, 1, values)
    with Session(engine) as db:
        shared = workspace_service.add_project_collaboration_group(
            db, int(group), int(crew["id"]), 2
        )
        assert shared["owner_type"] == source
        assert str(shared["owner_id"]) == str(source_id)
        assert shared["binding_owner_id"] == group
        workspace_service.remove_project_collaboration_group(
            db, int(group), int(crew["id"]), 2
        )
    return project, group, workspace, int(crew["id"])


def _case(engine: Engine, index: int, source: str, revoke: str) -> None:
    from app.models.resource_member import ResourceMember
    from app.schemas.base_role import BaseRole
    from app.schemas.cloud_project import CloudProjectMemberUpdate
    from app.schemas.workspace import WorkspaceMemberUpdate
    from app.services.cloud_projects import cloud_project_service
    from app.services.workspaces import workspace_service

    project, group, workspace, crew = _prepare(engine, index, source)
    snapshot_ready, begin_share, locked, release = Event(), Event(), Event(), Event()
    ids = {}

    def pause(_session):
        locked.set()
        assert release.wait(15), "Crew source revocation barrier was not released"

    def share():
        with Session(engine) as db:
            db.execute(text("SET SESSION innodb_lock_wait_timeout=15"))
            ids["writer"] = db.execute(text("SELECT CONNECTION_ID()")).scalar_one()
            # Authentication or another read can establish an older RR snapshot.
            db.query(ResourceMember).filter_by(entity_type="user", entity_id="2").all()
            snapshot_ready.set()
            assert begin_share.wait(15), "Crew share did not receive its start signal"
            try:
                result = workspace_service.add_project_collaboration_group(
                    db, int(group), crew, 2
                )
                return result
            except HTTPException as denied:
                db.rollback()
                return denied.status_code

    def revoke_source():
        with Session(engine) as db:
            db.execute(text("SET SESSION innodb_lock_wait_timeout=15"))
            ids["revoker"] = db.execute(text("SELECT CONNECTION_ID()")).scalar_one()
            event.listen(db, "before_commit", pause)
            if revoke == "grant":
                grant = (
                    db.query(ResourceMember)
                    .filter_by(
                        resource_type="CollaborationGroup",
                        resource_id=crew,
                        entity_type=source,
                        entity_id=str(workspace if source == "workspace" else project),
                    )
                    .one()
                )
                grant.status = "rejected"
                db.flush()
                db.commit()
            elif source == "workspace":
                workspace_service.update_member(
                    db, workspace, 2, 1, WorkspaceMemberUpdate(role=BaseRole.Viewer)
                )
            else:
                cloud_project_service.update_member(
                    db,
                    int(project),
                    2,
                    1,
                    CloudProjectMemberUpdate(role=BaseRole.Viewer),
                )

    with ThreadPoolExecutor(max_workers=2) as pool:
        writer = pool.submit(share)
        assert snapshot_ready.wait(10), "Crew share did not establish its read snapshot"
        revoker = pool.submit(revoke_source)
        assert locked.wait(10), "Source revocation did not reach its commit barrier"
        begin_share.set()
        try:
            _wait(engine, ids, "writer", writer)
        finally:
            release.set()
        revoker.result()
        outcome = writer.result()
    assert outcome in (403, 404, 422), outcome
    with Session(engine) as db:
        assert (
            db.query(ResourceMember)
            .filter_by(
                resource_type="CollaborationGroup",
                resource_id=crew,
                entity_type="chat_group",
                entity_id=group,
            )
            .count()
            == 0
        )
    print(
        f"MySQL crew sharing: source={source}, revocation={revoke}, rejected={outcome}",
        flush=True,
    )


def verify_group_crew_sharing(engine: Engine) -> None:
    index = 500
    for isolation in ("READ COMMITTED", "REPEATABLE READ"):
        for source in ("workspace", "project"):
            for revoke in ("role", "grant"):
                index += 1
                _case(
                    engine.execution_options(isolation_level=isolation),
                    index,
                    source,
                    revoke,
                )
