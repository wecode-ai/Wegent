# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""CI-only project row-lock checks using an isolated MySQL database."""

import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

PROJECT_IDS = ("1000000000000000001", "1000000000000000002")


def seed(engine: Engine) -> None:
    from app.db.base import Base
    from app.models.delivery import CloudProject, LoopNode
    from app.models.kind import Kind
    from app.models.project import Project
    from app.models.resource_member import ResourceMember
    from app.models.task import TaskResource
    from app.models.user import User

    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            Kind.__table__,
            Project.__table__,
            TaskResource.__table__,
            ResourceMember.__table__,
            LoopNode.__table__,
        ],
    )
    with Session(engine) as db:
        db.add(User(id=1, user_name="project-lock-owner", password_hash="unused"))
        db.add_all(
            CloudProject(
                id=project_id, name="Independent project", created_by_user_id=1
            )
            for project_id in PROJECT_IDS
        )
        db.commit()


def verify_query_plans(engine: Engine) -> None:
    from app.models.delivery import CloudProject

    plans = {}
    for kind, project_id in (
        ("numeric", int(PROJECT_IDS[0])),
        ("string", PROJECT_IDS[0]),
    ):
        with Session(engine) as db:
            statement = (
                db.query(CloudProject)
                .filter(CloudProject.id == project_id)
                .with_for_update()
                .statement
            )
            compiled = statement.compile(dialect=engine.dialect)
            rows = db.connection().exec_driver_sql(
                "EXPLAIN " + str(compiled), compiled.params
            )
            outer = next(row for row in rows.mappings() if row["table"] == "loop_items")
            plans[kind] = {key: outer[key] for key in ("type", "key", "rows")}
    print("MySQL: project lock query plans " + json.dumps(plans))
    assert plans["string"]["key"] == "PRIMARY", plans
    assert plans["numeric"]["key"] != "PRIMARY", plans


def verify_independent_locks(engine: Engine, *, numeric_control: bool) -> None:
    """Each transaction already owns one row before both take their second lock."""
    from app.models.delivery import CloudProject
    from app.services.cloud_projects.service import cloud_project_service

    ready = Barrier(2, timeout=5)

    def lock(project_id: str) -> str:
        with Session(engine) as db:
            db.execute(text("SET SESSION innodb_lock_wait_timeout = 3"))
            assert (
                db.execute(
                    select(CloudProject.id)
                    .where(CloudProject.id == project_id)
                    .with_for_update()
                ).scalar_one()
                == project_id
            )
            ready.wait()
            if numeric_control:
                # Reproduce the old SQL independently of the production method.
                projects = (
                    db.query(CloudProject)
                    .filter(CloudProject.id == int(project_id))
                    .populate_existing()
                    .with_for_update()
                    .all()
                )
                assert {str(project.id) for project in projects} == set(PROJECT_IDS)
                return project_id
            else:
                project = cloud_project_service._lock_project(db, int(project_id))
            return str(project.id)

    results, errors = [], []
    with ThreadPoolExecutor(max_workers=2) as workers:
        futures = [workers.submit(lock, project_id) for project_id in PROJECT_IDS]
        for future in futures:
            try:
                results.append(future.result(timeout=10))
            except OperationalError as exc:
                errors.append(exc.orig.args[0])
    if numeric_control:
        assert errors == [1213], (results, errors)
        assert len(results) == 1
        print("MySQL: numeric VARCHAR comparison reproduces the 1213 lock cycle")
    else:
        assert not errors, errors
        assert set(results) == set(PROJECT_IDS), results
        print(
            "MySQL: actual project service locks independent string keys concurrently"
        )


def main() -> None:
    url = make_url(os.environ["PROJECT_ADMIN_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("Only an explicitly configured local/CI MySQL is allowed")
    database = "test_project_admin_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    created = False
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f"CREATE DATABASE `{database}`")
            created = True
        os.environ["DATABASE_URL"] = url.set(database=database).render_as_string(
            hide_password=False
        )
        from app.db.session import engine

        seed(engine)
        verify_query_plans(engine)
        verify_independent_locks(engine, numeric_control=True)
        verify_independent_locks(engine, numeric_control=False)
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as connection:
                connection.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
