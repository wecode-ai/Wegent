"""Populated v1 MySQL data and interrupted-DDL recovery without migration."""

import os
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier
from typing import Any

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.delivery import CloudProject, ProjectChatAgent
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.cloud_project import CloudProjectCreate
from app.services.cloud_projects.responses import list_project_responses
from app.services.cloud_projects.service import cloud_project_service
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.project_chat.service import project_chat_service
from app.services.workspaces.responses import list_workspace_responses
from app.services.workspaces.storage import (
    ensure_resource_grant,
    workspace_kind_payload,
)


@pytest.fixture
def mysql_url() -> Iterator[str]:
    url = sa.engine.make_url(os.environ["COLLABORATION_PERMISSION_MYSQL_TEST_URL"])
    assert url.get_backend_name() == "mysql" and url.host in {"127.0.0.1", "localhost"}
    database = f"collaboration_permissions_test_{uuid.uuid4().hex}"
    admin = sa.create_engine(url.set(database="mysql"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as db:
            db.exec_driver_sql(f"CREATE DATABASE `{database}`")
            try:
                yield url.set(database=database).render_as_string(hide_password=False)
            finally:
                db.exec_driver_sql(f"DROP DATABASE `{database}`")
    finally:
        admin.dispose()


@pytest.mark.parametrize(
    "same_resource", [True, False], ids=["same-resource", "different-resources"]
)
def test_independent_workspace_resource_grants_do_not_lock_absent_identities(
    mysql_url: str,
    same_resource: bool,
) -> None:
    engine = sa.create_engine(mysql_url, isolation_level="REPEATABLE READ")
    ResourceMember.__table__.create(engine)
    ready = Barrier(2, timeout=10)

    def synchronize(
        _db: sa.Connection,
        _cursor: Any,
        statement: str,
        _params: Any,
        _context: Any,
        _many: bool,
    ) -> None:
        if statement.startswith("INSERT INTO resource_members"):
            # Both missing reads must finish before either transaction inserts.
            ready.wait()

    def authorize(index: int) -> int:
        with Session(engine, autoflush=False) as db:
            grant = ensure_resource_grant(
                db,
                workspace_id=11 + index,
                resource_type="Team",
                resource_id=101 if same_resource else 101 + index,
                added_by_user_id=1,
                role=BaseRole.Developer,
            )
            db.commit()
            return grant.id

    sa.event.listen(engine, "before_cursor_execute", synchronize)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(authorize, index) for index in range(2)]
            assert len({future.result(timeout=20) for future in futures}) == 2
        with Session(engine) as db:
            assert db.query(ResourceMember).count() == 2
    finally:
        sa.event.remove(engine, "before_cursor_execute", synchronize)
        engine.dispose()


def test_concurrent_workspace_resource_grants_share_one_identity_after_stale_reads(
    mysql_url: str,
) -> None:
    engine = sa.create_engine(mysql_url, isolation_level="REPEATABLE READ")
    ResourceMember.__table__.create(engine)
    ready = Barrier(4, timeout=10)

    def authorize() -> int:
        with Session(engine, autoflush=False) as db:
            # Request authorization may establish a snapshot before a grant exists.
            assert db.query(ResourceMember).first() is None
            ready.wait()
            grant = ensure_resource_grant(
                db,
                workspace_id=11,
                resource_type="Team",
                resource_id=101,
                added_by_user_id=1,
                role=BaseRole.Developer,
            )
            db.commit()
            return grant.id

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(authorize) for _ in range(4)]
            assert len({future.result(timeout=20) for future in futures}) == 1
        with Session(engine) as db:
            grant = db.query(ResourceMember).one()
            assert (grant.role, grant.status, grant.invited_by_user_id) == (
                "Developer",
                "approved",
                1,
            )
    finally:
        engine.dispose()


def test_workspace_resource_grant_restoration_reads_current_audit_metadata(
    mysql_url: str,
) -> None:
    engine = sa.create_engine(mysql_url, isolation_level="REPEATABLE READ")
    ResourceMember.__table__.create(engine)
    timestamp = datetime(2020, 1, 2, 3, 4, 5)
    try:
        with Session(engine) as db:
            grant = ResourceMember.create(
                resource_type="Team",
                resource_id=101,
                entity_type="workspace",
                entity_id="11",
                role="Reporter",
                status="rejected",
                invited_by_user_id=1,
                requested_at=timestamp,
            )
            grant.created_at = timestamp
            db.add(grant)
            db.commit()
            grant_id = grant.id
        with Session(engine) as db:
            stale = db.get(ResourceMember, grant_id)
            assert stale is not None and stale.share_link_id == 0
            with Session(engine) as writer:
                current = writer.get(ResourceMember, grant_id)
                current.entity_display_name = "Concurrent metadata"
                current.share_link_id = 13
                current.reviewed_by_user_id = 17
                writer.commit()
            restored = ensure_resource_grant(
                db,
                workspace_id=11,
                resource_type="Team",
                resource_id=101,
                added_by_user_id=7,
                role=BaseRole.Developer,
            )
            assert restored is stale
            assert (restored.role, restored.status, restored.invited_by_user_id) == (
                "Developer",
                "approved",
                7,
            )
            assert restored.entity_display_name == "Concurrent metadata"
            assert (restored.share_link_id, restored.reviewed_by_user_id) == (13, 17)
            assert (restored.requested_at, restored.created_at) == (timestamp,) * 2
            db.commit()
    finally:
        engine.dispose()


def test_independent_project_creation_does_not_lock_absent_parent_grants(
    mysql_url: str,
) -> None:
    engine = sa.create_engine(mysql_url, isolation_level="REPEATABLE READ")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(User(id=1, user_name="project-owner", password_hash="unused"))
        for workspace_id in (11, 12):
            db.add(
                Kind(
                    id=workspace_id,
                    kind="CollaborationWorkspace",
                    name=f"space-{workspace_id}",
                    namespace="default",
                    user_id=1,
                    is_active=True,
                    json=workspace_kind_payload(
                        name=f"space-{workspace_id}",
                        description="",
                        namespace="default",
                        public_id=str(uuid.uuid4()),
                        is_default=False,
                    ),
                )
            )
        db.commit()

    ready = Barrier(2, timeout=10)

    def synchronize(
        _db: sa.Connection,
        _cursor: Any,
        statement: str,
        _params: Any,
        context: Any,
        _many: bool,
    ) -> None:
        if not statement.startswith("INSERT INTO resource_members"):
            return
        values = context.compiled_parameters[0] if context.compiled_parameters else {}
        if (
            values.get("resource_type") == "CloudProject"
            and values.get("entity_type") == "workspace"
        ):
            ready.wait()

    def create_project(workspace_id: int) -> str:
        with Session(engine) as db:
            project = cloud_project_service.create(
                db,
                1,
                CloudProjectCreate(
                    name="Concurrent project", workspace_id=str(workspace_id)
                ),
            )
            parent = (
                db.query(ResourceMember)
                .filter_by(
                    resource_type="CloudProject",
                    resource_id=int(project.id),
                    entity_type="workspace",
                    entity_id=str(workspace_id),
                )
                .one()
            )
            assert parent.role == "Owner" and parent.status == "approved"
            assert collaboration_permission_service.check(
                db, 1, "execute", project.id
            ).allowed
            return project.id

    sa.event.listen(engine, "before_cursor_execute", synchronize)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(create_project, workspace_id) for workspace_id in (11, 12)
            ]
            assert len({future.result(timeout=20) for future in futures}) == 2
    finally:
        sa.event.remove(engine, "before_cursor_execute", synchronize)
        engine.dispose()


@pytest.mark.parametrize("interrupted_ddl", [False, True])
def test_populated_v1_database_preserves_records_and_both_backend_writers(
    mysql_url, interrupted_ddl
):
    engine = sa.create_engine(mysql_url)
    Base.metadata.create_all(engine)
    if interrupted_ddl:
        with engine.begin() as db:
            db.exec_driver_sql("ALTER TABLE loop_items ADD workspace_id INT NULL")
            db.exec_driver_sql(
                "ALTER TABLE loop_items ADD membership_mode VARCHAR(16) NOT NULL DEFAULT 'inherit'"
            )
            db.exec_driver_sql(
                "CREATE TABLE collaboration_permission_migration_backup (id INT PRIMARY KEY, entity VARCHAR(32), entity_id VARCHAR(64), `values` JSON)"
            )
    with Session(engine) as db:
        owner = User(user_name="legacy-owner", password_hash="unused", is_active=True)
        db.add(owner)
        db.flush()
        space = Kind(
            kind="CollaborationWorkspace",
            name="Legacy space",
            namespace="default",
            user_id=owner.id,
            is_active=True,
            json=workspace_kind_payload(
                name="Legacy space",
                description="",
                namespace="default",
                public_id=str(uuid.uuid4()),
                is_default=False,
            ),
        )
        db.add(space)
        db.flush()
        project = CloudProject(
            id="1001",
            name="Existing project",
            created_by_user_id=owner.id,
            public_id=str(uuid.uuid4()),
            project_key="LEGACY",
            metadata_json={"tags": ["keep"]},
        )
        db.add(project)
        db.flush()
        db.add_all(
            [
                ResourceMember.create(
                    resource_type="Workspace",
                    resource_id=space.id,
                    entity_id=str(owner.id),
                    role="Owner",
                    status="approved",
                ),
                ResourceMember.create(
                    resource_type="CloudProject",
                    resource_id=1001,
                    entity_type="workspace",
                    entity_id=str(space.id),
                    role="Owner",
                    status="approved",
                ),
                ResourceMember.create(
                    resource_type="CloudProject",
                    resource_id=1001,
                    entity_id=str(owner.id),
                    role="Owner",
                    status="approved",
                ),
            ]
        )
        agent = ProjectChatAgent(
            cloud_project_id=project.id,
            name="Legacy Agent",
            created_by_user_id=owner.id,
            metadata_json={"runtime": "codex", "visibility": "creator_admin"},
        )
        db.add(agent)
        db.commit()
        original = [
            dict(row)
            for row in db.execute(sa.select(ResourceMember.__table__)).mappings()
        ]
        statements = []

        def capture(_db, _cursor, statement, _params, _context, _many):
            statements.append(statement)

        sa.event.listen(engine, "before_cursor_execute", capture)
        try:
            projects = list_project_responses(db, owner)
            spaces = list_workspace_responses(db, owner.id)
            assert len(projects) == len(spaces) == 1
            assert projects[0].access_role == "Maintainer"
            assert spaces[0].project_count == 1
            agents = project_chat_service.list_agents(
                db, user_id=owner.id, project_id=project.id
            )
            assert len(agents) == 1 and agents[0].can_use
            assert collaboration_permission_service.check(
                db, owner.id, "execute", project.id
            ).allowed
        finally:
            sa.event.remove(engine, "before_cursor_execute", capture)
        assert all(
            statement.lstrip().upper().startswith("SELECT") for statement in statements
        )
        assert [
            dict(row)
            for row in db.execute(sa.select(ResourceMember.__table__)).mappings()
        ] == original
        created = cloud_project_service.create(
            db,
            owner.id,
            CloudProjectCreate(
                name="Created by new backend",
                workspace_id=str(space.id),
                membership_mode="restricted",
            ),
        )
        old_parent = (
            db.query(ResourceMember)
            .filter_by(
                resource_type="CloudProject",
                resource_id=int(created.id),
                entity_type="workspace",
                status="approved",
            )
            .one()
        )
        assert old_parent.entity_id == str(space.id) and old_parent.role == "Owner"
        legacy_second = CloudProject(
            id="1002",
            name="Later v1 creation",
            created_by_user_id=owner.id,
            public_id=str(uuid.uuid4()),
            project_key="LEGACY2",
            metadata_json={"tags": []},
        )
        db.add(legacy_second)
        db.flush()
        db.add(
            ResourceMember.create(
                resource_type="CloudProject",
                resource_id=1002,
                entity_type="workspace",
                entity_id=str(space.id),
                role="Owner",
                status="approved",
            )
        )
        db.commit()
        assert len(list_project_responses(db, owner)) == 3
        assert {row.id for row in list_project_responses(db, owner)} == {
            "1001",
            "1002",
            created.id,
        }
        assert db.get(CloudProject, "1001").metadata_json == {"tags": ["keep"]}
    engine.dispose()
