"""CI-covered MySQL checks for owner-scoped registration serialization."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.device_service import device_service


def register(engine: Engine, owner: int, ready: Barrier | None = None) -> int:
    with Session(engine) as db:
        # Authentication can establish a snapshot before registration begins.
        assert db.query(User.id).filter(User.id == owner).scalar() == owner
        if ready is not None:
            ready.wait()
        return device_service.upsert_device_crd(
            db,
            user_id=owner,
            device_id=f"app-{owner}",
            name="MySQL registration test",
            device_type="app",
            runtime_instance_id=f"runtime-{owner}",
            app_device_id=f"electron-{owner}",
        ).id


def verify_independent_owners(engine: Engine) -> None:
    """Make both absent identity reads finish before either insert starts."""
    ready = Barrier(2, timeout=10)

    def synchronize(connection, cursor, statement, parameters, context, executemany):
        if (
            statement.startswith("SELECT")
            and "FROM kinds" in statement
            and "kinds.name =" in statement
        ):
            ready.wait()

    event.listen(engine, "after_cursor_execute", synchronize)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(register, engine, owner) for owner in (1, 2)]
            ids = [future.result(timeout=20) for future in futures]
        assert len(set(ids)) == 2, ids
    finally:
        event.remove(engine, "after_cursor_execute", synchronize)
    print("MySQL: independent owners register concurrently without gap-lock deadlock")


def verify_shared_owner(engine: Engine) -> None:
    """The owner lock must still serialize concurrent first registrations."""
    ready = Barrier(8, timeout=10)

    def concurrent_registration(_: int) -> int:
        return register(engine, 3, ready)

    with ThreadPoolExecutor(max_workers=8) as pool:
        ids = list(pool.map(concurrent_registration, range(8)))
    assert len(set(ids)) == 1, ids
    with Session(engine) as db:
        devices = db.query(Kind).filter_by(user_id=3, kind="Device").all()
        assert len(devices) == 1
        assert devices[0].id == ids[0]
    print("MySQL: eight first registrations retain one owned installation")


def main() -> None:
    url = make_url(os.environ["DEVICE_REGISTRATION_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("Only an explicitly configured local/CI MySQL is allowed")
    database = "test_device_registration_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    created = False
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f"CREATE DATABASE `{database}`")
            created = True
        engine = create_engine(
            url.set(database=database), isolation_level="REPEATABLE READ"
        )
        for table in (User.__table__, Kind.__table__):
            table.create(engine)
        with Session(engine) as db:
            for owner in (1, 2, 3):
                db.add(
                    User(
                        id=owner,
                        user_name=f"registration-owner-{owner}",
                        password_hash="unused",
                    )
                )
            db.commit()
        verify_independent_owners(engine)
        verify_shared_owner(engine)
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as connection:
                connection.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
