"""Execute the Rust catalog's actual SQL against the approved Python policy."""

from concurrent.futures import ThreadPoolExecutor
from itertools import product
from pathlib import Path
from threading import Event

import sqlalchemy as sa
from fastapi import HTTPException
from pymysql.constants import FLAG
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.delivery import CloudProject, ProjectChatAgent
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.cloud_project_visibility import project_access_query
from app.services.workspaces import workspace_service
from app.services.workspaces.storage import workspace_kind_payload
from integration_checks import test_collaboration_permission_mysql as mysql_contract

mysql_url = mysql_contract.mysql_url

SQL = (
    Path(__file__).parents[2] / "backend-rs/src/cloud_projects/collaboration_access.sql"
).read_text()


def test_workspace_archive_rechecks_children_after_concurrent_restore(mysql_url):
    engine = sa.create_engine(mysql_url, isolation_level="REPEATABLE READ")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(User(id=1, user_name="recovery-owner", password_hash="unused"))
        db.flush()
        db.add(
            Kind(
                id=11,
                kind="CollaborationWorkspace",
                name="Recovery parent",
                namespace="default",
                user_id=1,
                is_active=True,
                json=workspace_kind_payload(
                    name="Recovery parent",
                    description="",
                    namespace="default",
                    public_id="recovery-parent",
                    is_default=False,
                ),
            )
        )
        db.add(
            CloudProject(
                id="1001",
                name="Recovering child",
                project_key="REC",
                public_id="recovering-child",
                created_by_user_id=1,
                status="archived",
            )
        )
        db.add(
            ResourceMember.create(
                resource_type="CloudProject",
                resource_id=1001,
                entity_type="workspace",
                entity_id="11",
                role="Owner",
                status="approved",
            )
        )
        db.commit()

    restore_locked = Event()
    archive_waiting = Event()

    def before_query(connection, _cursor, statement, _params, _context, _many):
        if (
            connection.info.get("recovery_test_archive")
            and statement.startswith("SELECT")
            and "kinds" in statement
            and "FOR UPDATE" in statement
        ):
            archive_waiting.set()

    def restore():
        with engine.begin() as connection:
            connection.execute(
                sa.text("SELECT id FROM kinds WHERE id = 11 FOR UPDATE")
            ).one()
            connection.execute(
                sa.text("SELECT id FROM loop_items WHERE id = '1001' FOR UPDATE")
            ).one()
            restore_locked.set()
            assert archive_waiting.wait(10), "Archive must wait on the parent lock"
            connection.execute(
                sa.text(
                    "UPDATE loop_items SET status = 'active', version = version + 1 "
                    "WHERE id = '1001' AND status = 'archived'"
                )
            )

    sa.event.listen(engine, "before_cursor_execute", before_query)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            restored = pool.submit(restore)
            assert restore_locked.wait(10)
            with Session(engine) as db:
                connection = db.connection()
                connection_info = connection.info
                connection_info["recovery_test_archive"] = True
                try:
                    workspace_service.archive(db, 11, 1, 1)
                except HTTPException as error:
                    assert error.status_code == 409
                    assert "active Projects" in error.detail
                    db.rollback()
                else:
                    raise AssertionError("A restored active child must block archival")
                finally:
                    connection_info.pop("recovery_test_archive", None)
            restored.result(timeout=10)
        with Session(engine) as db:
            assert db.get(Kind, 11).is_active
            assert db.get(CloudProject, "1001").status == "active"
    finally:
        sa.event.remove(engine, "before_cursor_execute", before_query)
        engine.dispose()


def test_cp02_cp03_cp04_cp05_cp06_cp07_cp13_cp18_cp19_rust_catalog_mysql_policy(
    mysql_url,
):
    engine = sa.create_engine(mysql_url)
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as db:
            owner = User(
                user_name="space-owner", password_hash="unused", is_active=True
            )
            member = User(
                user_name="project-guest", password_hash="unused", is_active=True
            )
            db.add_all([owner, member])
            db.flush()
            space = Kind(
                kind="CollaborationWorkspace",
                name="Parent",
                namespace="default",
                user_id=owner.id,
                is_active=True,
                json={"metadata": {"publicId": "parent-public"}},
            )
            db.add(space)
            db.flush()
            project_row = CloudProject(
                id="1001",
                name="Visible project",
                project_key="CP",
                public_id="project-public",
                created_by_user_id=member.id,
                metadata_json={"membership_mode": "inherit"},
            )
            db.add(project_row)

            def grant(kind, resource_id, entity_type, entity_id, role):
                row = ResourceMember.create(
                    resource_type=kind,
                    resource_id=resource_id,
                    entity_type=entity_type,
                    entity_id=str(entity_id),
                    role=role,
                    status="approved",
                )
                db.add(row)
                return row

            parent = grant("CloudProject", 1001, "workspace", space.id, "Owner")
            db.flush()

            def priorities(user_id):
                db.flush()
                source = {
                    str(row.id): priority
                    for row, priority in project_access_query(db, user_id).all()
                }
                query = SQL.format(
                    columns="loop_items.id AS project_id",
                    user_id=int(user_id),
                    project_filter="",
                    workspace_filter="",
                    project_status="active",
                    workspace_predicate="kinds.is_active = true",
                )
                result = db.execute(sa.text(query))
                # PyMySQL also decodes binary JSON expressions to Python str.
                # Rust's driver requires a text column on the wire, so values
                # alone do not protect the HTTP catalog from decode failures.
                fields = result.cursor._result.fields
                public_id_field = next(
                    field for field in fields if field.name == "workspace_public_id"
                )
                assert (
                    not public_id_field.flags & FLAG.BINARY
                ), "Parent public ID must be SQL text for Rust decoding"
                rows = result.all()
                expected_public_id = space.json.get("metadata", {}).get("publicId")
                assert all(
                    row.workspace_public_id == expected_public_id for row in rows
                )
                # Point lookups decode the same parent and permission-source
                # columns as lists; compare real MySQL rows, including denied
                # and absent projects, for every authorization case below.
                for project_id in ("1001", "9999"):
                    point_query = SQL.format(
                        columns="loop_items.id AS project_id",
                        user_id=int(user_id),
                        project_filter=f"AND loop_items.id = '{project_id}'",
                        workspace_filter="",
                        project_status="active",
                        workspace_predicate="kinds.is_active = true",
                    )
                    point_rows = db.execute(sa.text(point_query)).all()
                    assert [dict(row._mapping) for row in point_rows] == [
                        dict(row._mapping)
                        for row in rows
                        if str(row.project_id) == project_id
                    ]
                actual = {str(row.project_id): row.anon_1_priority for row in rows}
                assert actual == source
                return actual

            # A historical creator is not an administrator or even a member.
            assert priorities(member.id) == {}
            # Space ownership supplies project governance without a member row.
            assert priorities(owner.id) == {"1001": 1}
            # A creator's explicit administration is Maintainer, never Owner.
            direct_admin = grant("CloudProject", 1001, "user", member.id, "Maintainer")
            assert priorities(member.id) == {"1001": 1}
            db.delete(direct_admin)
            # Transferring actual ownership moves inherited project authority;
            # historical creator identity cannot preserve or elevate access.
            space.user_id = member.id
            assert priorities(owner.id) == {}
            assert priorities(member.id) == {"1001": 1}
            space.user_id = owner.id
            assert priorities(owner.id) == {"1001": 1}
            assert priorities(member.id) == {}
            # A direct grant cannot downgrade the space owner's governance.
            owner_override = grant("CloudProject", 1001, "user", owner.id, "Viewer")
            assert priorities(owner.id) == {"1001": 1}
            db.delete(owner_override)
            for metadata in ({"publicId": "空间-public"}, {"publicId": None}, {}):
                space.json = {"metadata": metadata}
                assert priorities(owner.id) == {"1001": 1}
            space.json = {"metadata": {"publicId": "parent-public"}}
            for mode, space_role, direct_role in product(
                ("inherit", "restricted"),
                (None, "Owner", "Maintainer", "Developer", "Reporter", "Viewer"),
                (None, "Viewer", "Developer", "Maintainer"),
            ):
                db.query(ResourceMember).filter(
                    ResourceMember.entity_type == "user",
                    ResourceMember.entity_id == str(member.id),
                ).delete(synchronize_session=False)
                project_row.membership_mode = mode
                if space_role:
                    grant("Workspace", space.id, "user", member.id, space_role)
                if direct_role:
                    grant("CloudProject", 1001, "user", member.id, direct_role)
                actual = priorities(member.id)
                role_priorities = {
                    "Owner": 1,
                    "Maintainer": 1,
                    "Developer": 2,
                    "Reporter": 4,
                    "Viewer": 4,
                }
                if space_role in {"Owner", "Maintainer"}:
                    expected = 1
                elif direct_role:
                    expected = role_priorities[direct_role]
                elif mode == "inherit" and space_role:
                    expected = role_priorities[space_role]
                else:
                    expected = None
                assert actual == ({} if expected is None else {"1001": expected})
                if (
                    mode == "restricted"
                    and space_role == "Developer"
                    and not direct_role
                ):
                    assert actual == {}
                if not space_role and direct_role == "Developer":
                    assert actual == {"1001": 2}

            db.query(ResourceMember).filter(
                ResourceMember.entity_type == "user"
            ).delete()
            project_row.membership_mode = "inherit"
            inherited = grant("Workspace", space.id, "user", member.id, "Developer")
            override = grant("CloudProject", 1001, "user", member.id, "Viewer")
            assert priorities(member.id) == {"1001": 4}
            for invalid_status in ("pending", "rejected", "revoked"):
                override.status = invalid_status
                assert priorities(member.id) == {"1001": 2}
            override.status = "approved"
            override.role = "invalid"
            assert priorities(member.id) == {"1001": 2}
            override.role = "Viewer"
            assert priorities(member.id) == {"1001": 4}
            db.delete(override)
            assert priorities(member.id) == {"1001": 2}
            db.delete(inherited)
            public = grant(
                "CloudProject", 1001, "authenticated_users", "*", "Developer"
            )
            assert priorities(member.id) == {"1001": 4}
            public.status = "revoked"
            assert priorities(member.id) == {}
            grant("CloudProject", 1001, "user", member.id, "Developer")
            assert priorities(member.id) == {"1001": 2}
            space.is_active = False
            assert priorities(member.id) == {}
            space.is_active = True
            member.is_active = False
            assert priorities(member.id) == {}
            member.is_active = True
            ambiguous = grant(
                "CloudProject", 1001, "workspace", space.id + 1000, "Owner"
            )
            assert priorities(member.id) == {}
            db.delete(ambiguous)
            parent.status = "revoked"
            assert priorities(member.id) == {}

            # Recycle-bin discovery reuses the canonical permission projection,
            # but grants lifecycle recovery only to effective administrators.
            parent.status = "approved"
            project_row.status = "archived"

            def recoverable(user_id):
                db.flush()
                query = SQL.format(
                    columns="loop_items.id AS project_id",
                    user_id=int(user_id),
                    project_filter="AND access.priority <= 1",
                    workspace_filter="",
                    project_status="archived",
                    workspace_predicate=f"(kinds.is_active = true OR kinds.user_id = {int(user_id)})",
                )
                return {
                    str(row.project_id): bool(row.workspace_active)
                    for row in db.execute(sa.text(query)).all()
                }

            for mode, role, grant_status in product(
                ("inherit", "restricted"),
                ("Maintainer", "Developer", "Viewer"),
                ("approved", "pending", "rejected", "revoked"),
            ):
                db.query(ResourceMember).filter(
                    ResourceMember.entity_type == "user",
                    ResourceMember.entity_id == str(member.id),
                ).delete(synchronize_session=False)
                project_row.membership_mode = mode
                direct = grant("CloudProject", 1001, "user", member.id, role)
                direct.status = grant_status
                assert recoverable(member.id) == (
                    {"1001": True}
                    if role == "Maintainer" and grant_status == "approved"
                    else {}
                )
                assert priorities(owner.id) == {}
                assert recoverable(owner.id) == {"1001": True}
            direct.role = "Maintainer"
            direct.status = "approved"
            space.is_active = False
            assert recoverable(member.id) == {}
            assert recoverable(owner.id) == {"1001": False}
            space.user_id = member.id
            assert recoverable(owner.id) == {}
            assert recoverable(member.id) == {"1001": False}
            space.user_id = owner.id
            space.is_active = True
            project_row.status = "active"
            parent.status = "revoked"

            device = Kind(
                kind="Device",
                name="runner",
                namespace="default",
                user_id=owner.id,
                is_active=True,
                json={"spec": {}},
            )
            db.add(device)
            db.flush()
            grant("Device", device.id, "workspace", space.id, "Developer")
            project_grant = grant("Device", device.id, "project", "1001", "Developer")
            project_grant.status = "revoked"
            grant("Device", device.id, "project", "2000", "Developer")
            agent = ProjectChatAgent(
                cloud_project_id="1001",
                name="Legacy installation",
                created_by_user_id=owner.id,
                device_id="runner",
                status="active",
            )
            db.add(agent)
            db.flush()
            sql_dir = Path(__file__).parents[2] / "backend-rs/src/cloud_projects"
            grants_sql = (
                (sql_dir / "environment_grants.sql").read_text().replace("?", "%s")
            )
            rows = (
                db.connection()
                .exec_driver_sql(grants_sql, (str(space.id), "1001"))
                .mappings()
                .all()
            )
            assert {(r["entity_type"], r["status"]) for r in rows} == {
                ("workspace", "approved"),
                ("project", "revoked"),
            }
            agents_sql = (
                (sql_dir / "legacy_environment_agents.sql")
                .read_text()
                .replace("?", "%s")
            )
            assert (
                db.connection().exec_driver_sql(agents_sql, ("1001",)).one().device_id
                == "runner"
            )
            agent.status = "archived"
            db.flush()
            assert db.connection().exec_driver_sql(agents_sql, ("1001",)).all() == []
    finally:
        engine.dispose()
