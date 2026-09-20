# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise namespace grants with real MySQL connection collations."""

import os
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.services.adapters.team_kinds import team_kinds_service


@pytest.fixture(scope="module")
def mysql_url() -> Iterator[URL]:
    url = make_url(os.environ["TEAM_NAMESPACE_MYSQL_TEST_URL"])
    assert url.get_backend_name() == "mysql"
    assert url.host in {"127.0.0.1", "localhost"}
    database = f"team_namespace_test_{uuid.uuid4().hex}"
    admin_engine = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    try:
        with admin_engine.connect() as connection:
            connection.exec_driver_sql(f"CREATE DATABASE `{database}`")
            try:
                yield url.set(database=database)
            finally:
                connection.exec_driver_sql(f"DROP DATABASE `{database}`")
    finally:
        admin_engine.dispose()


@pytest.fixture
def mysql_db(mysql_url: URL) -> Iterator[Session]:
    engine = create_engine(mysql_url)
    try:
        for model in (Kind, Namespace, ResourceMember):
            model.__table__.create(engine, checkfirst=True)
        with Session(engine) as db:
            yield db
            db.rollback()
    finally:
        engine.dispose()


def _create_namespace_grants(db: Session, member_role: str) -> tuple[Namespace, Kind]:
    child = Namespace(name="parent/child", owner_user_id=1)
    db.add(child)
    db.flush()
    db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=child.id,
            entity_type="user",
            entity_id="2",
            role=member_role,
            status="approved",
        )
    )
    allowed_team = None
    for name, entity_type, entity_id, status in (
        ("allowed", "namespace", str(child.id), "approved"),
        ("pending", "namespace", str(child.id), "pending"),
        ("malformed", "namespace", f"{child.id}suffix", "approved"),
        ("workspace", "workspace", str(child.id), "approved"),
        ("other-namespace", "namespace", str(child.id + 1), "approved"),
    ):
        team = Kind(user_id=1, kind="Team", name=name, namespace="parent", json={})
        db.add(team)
        db.flush()
        db.add(
            ResourceMember(
                resource_type="Team",
                resource_id=team.id,
                entity_type=entity_type,
                entity_id=entity_id,
                role="Reporter",
                status=status,
            )
        )
        if name == "allowed":
            allowed_team = team
    db.flush()
    assert allowed_team is not None
    return child, allowed_team


@pytest.mark.parametrize("collation", ["utf8mb4_0900_ai_ci", "utf8mb4_unicode_ci"])
@pytest.mark.parametrize("member_role", ["Reporter", "RestrictedAnalyst"])
def test_namespace_grants_with_connection_collation(
    mysql_db: Session, collation: str, member_role: str
) -> None:
    mysql_db.execute(text(f"SET NAMES utf8mb4 COLLATE {collation}"))
    child, team = _create_namespace_grants(mysql_db, member_role)

    result = team_kinds_service._build_accessible_teams_query(
        mysql_db, user_id=2, scope="group", group_name=child.name
    )

    assert result is not None
    query, _ = result
    assert query.count() == 1
    rows = query.limit(1).all()
    assert [row.team_id for row in rows] == [team.id]
    assert rows[0].access_source == "namespace_authorization"
    assert rows[0].restricted_guest_access == (member_role == "RestrictedAnalyst")
