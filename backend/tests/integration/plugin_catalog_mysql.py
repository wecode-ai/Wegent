"""CI-covered MySQL checks for concurrent plugin catalog publication."""

import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from queue import Queue

from sqlalchemy import create_engine, null, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.plugin_marketplace import Plugin, PluginRelease
from app.services.plugin_catalog_storage import (
    create_or_lock_plugin_release,
    lock_catalog_plugin,
)


def plugin_identity(db: Session, slug: str, label: str = "original") -> Plugin:
    return lock_catalog_plugin(
        db,
        catalog_namespace="enterprise",
        slug=slug,
        initial_values={"name": slug, "display_name": label},
    )


def release_identity(db: Session, plugin_id: int) -> tuple[PluginRelease, bool]:
    return create_or_lock_plugin_release(
        db,
        {
            "plugin_id": plugin_id,
            "version": "1.0.0",
            "sha256": "a" * 64,
            "storage_key": "pending",
            "size_bytes": 1,
        },
    )


def verify_independent_plugins(engine: Engine) -> None:
    """A new plugin must not lock another absent slug in the same index gap."""
    with Session(engine) as first:
        alpha = plugin_identity(first, "parallel-alpha")

        def publish_beta() -> int:
            with Session(engine) as second:
                second.execute(text("SET SESSION innodb_lock_wait_timeout = 2"))
                beta = plugin_identity(second, "parallel-beta")
                plugin_id = beta.id
                second.commit()
                return plugin_id

        with ThreadPoolExecutor(max_workers=1) as pool:
            beta_id = pool.submit(publish_beta).result(timeout=10)
        assert alpha.id != beta_id
        first.commit()
    print("MySQL: different new plugin identities commit independently")


def verify_independent_releases(engine: Engine) -> None:
    """An uncommitted release must not gap-lock another plugin's version."""
    with Session(engine) as db:
        first_id = plugin_identity(db, "release-alpha").id
        second_id = plugin_identity(db, "release-beta").id
        db.commit()
    with Session(engine) as first:
        alpha, created = release_identity(first, first_id)
        assert created

        def publish_beta() -> int:
            with Session(engine) as second:
                second.execute(text("SET SESSION innodb_lock_wait_timeout = 2"))
                beta, created = release_identity(second, second_id)
                assert created
                release_id = beta.id
                second.commit()
                return release_id

        with ThreadPoolExecutor(max_workers=1) as pool:
            beta_id = pool.submit(publish_beta).result(timeout=10)
        assert alpha.id != beta_id
        first.commit()
    print("MySQL: different plugin releases commit independently")


def verify_same_identity(engine: Engine) -> None:
    """A competing publisher waits, then sees the committed identity and release."""
    started: Queue[int] = Queue()
    with Session(engine) as first:
        plugin = plugin_identity(first, "same-plugin")
        release, created = release_identity(first, plugin.id)
        assert created
        expected = (plugin.id, release.id, plugin.display_name)

        def publish_again() -> tuple[int, int, str]:
            with Session(engine) as second:
                second.execute(text("SET SESSION innodb_lock_wait_timeout = 10"))
                # Establish an older repeatable-read snapshot before the first
                # publisher commits. Identity reads must still see fresh rows.
                assert (
                    second.query(Plugin).filter_by(slug="same-plugin").first() is None
                )
                started.put(second.execute(text("SELECT CONNECTION_ID()")).scalar_one())
                plugin = plugin_identity(second, "same-plugin", "replacement")
                release, created = release_identity(second, plugin.id)
                assert not created
                result = (plugin.id, release.id, plugin.display_name)
                second.commit()
                return result

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(publish_again)
            connection_id = started.get(timeout=10)
            deadline = time.monotonic() + 5
            with engine.connect() as observer:
                while True:
                    state = observer.execute(
                        text(
                            "SELECT trx_state FROM information_schema.innodb_trx "
                            "WHERE trx_mysql_thread_id = :connection_id"
                        ),
                        {"connection_id": connection_id},
                    ).scalar_one_or_none()
                    if state == "LOCK WAIT":
                        break
                    assert (
                        time.monotonic() < deadline
                    ), "Publisher did not wait on identity"
                    time.sleep(0.01)
            first.commit()
            assert future.result(timeout=10) == expected
    print(
        "MySQL: one identity serializes concurrent publishers without replacing metadata"
    )


def verify_rollback_and_constraints(engine: Engine) -> None:
    """Release savepoints preserve outer rollback and propagate invalid data."""
    with Session(engine) as db:
        plugin = plugin_identity(db, "rollback-plugin")
        plugin_id = plugin.id
        _, created = release_identity(db, plugin_id)
        assert created
        db.rollback()
        assert db.query(Plugin).filter_by(slug="rollback-plugin").first() is None
        assert db.query(PluginRelease).filter_by(plugin_id=plugin_id).first() is None

        plugin = plugin_identity(db, "invalid-release-plugin")
        db.commit()
        try:
            create_or_lock_plugin_release(
                db,
                {
                    "plugin_id": plugin.id,
                    "version": "1.0.0",
                    "storage_key": null(),
                    "sha256": "a" * 64,
                    "size_bytes": 1,
                },
            )
        except IntegrityError as error:
            assert error.orig.args[0] == 1048
            db.rollback()
        else:
            raise AssertionError("An invalid release was accepted")
    print("MySQL: outer rollback removes releases and invalid data is rejected")


def main() -> None:
    url = make_url(os.environ["PLUGIN_CATALOG_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("Only an explicitly configured local/CI MySQL is allowed")
    database = "test_plugin_catalog_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    created = False
    try:
        with admin.connect() as db:
            db.exec_driver_sql(f"CREATE DATABASE `{database}`")
            created = True
        engine = create_engine(
            url.set(database=database), isolation_level="REPEATABLE READ"
        )
        Plugin.__table__.create(engine)
        PluginRelease.__table__.create(engine)
        verify_independent_plugins(engine)
        verify_independent_releases(engine)
        verify_same_identity(engine)
        verify_rollback_and_constraints(engine)
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as db:
                db.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
