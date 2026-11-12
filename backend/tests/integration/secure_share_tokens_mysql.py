"""Verify share-token migration against an explicit disposable MySQL service."""

import hashlib
import os
import uuid

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session

from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.models.share_link import ShareLink
from app.services.share.token_access import share_token_lookup
from tests.models.test_secure_share_link_migration import _load_migration


def create_legacy_share_links(engine: Engine) -> None:
    """Create the pre-security table for historical integration fixtures."""
    with engine.begin() as db:
        db.exec_driver_sql(
            "CREATE TABLE share_links ("
            "id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,"
            "resource_type VARCHAR(50) NOT NULL,resource_id BIGINT NOT NULL,"
            "share_token VARCHAR(512) NOT NULL,"
            "require_approval BOOL NOT NULL,default_role VARCHAR(20) NOT NULL,"
            "expires_at DATETIME NOT NULL,created_by_user_id INT NOT NULL,"
            "is_active BOOL NOT NULL,created_at DATETIME NOT NULL,"
            "updated_at DATETIME NOT NULL,"
            "UNIQUE KEY uniq_share_links_share_token (share_token))"
        )


def _insert(engine: Engine, token: str) -> None:
    with engine.begin() as db:
        db.execute(
            text(
                "INSERT INTO share_links (resource_type,resource_id,share_token,"
                "require_approval,default_role,expires_at,created_by_user_id,"
                "is_active,created_at,updated_at) VALUES "
                "('Task',1,:token,0,'Reporter','9999-12-31',7,1,NOW(),NOW())"
            ),
            {"token": token},
        )


def verify(engine: Engine) -> None:
    create_legacy_share_links(engine)
    for token in ("legacy-a", "legacy-b%2B%3D"):
        _insert(engine, token)
    with engine.begin() as db:
        migration = _load_migration(Operations(MigrationContext.configure(db)))
        migration.upgrade()
        rows = db.execute(
            text(
                "SELECT share_token,token_hash,token_version,is_active FROM share_links ORDER BY id"
            )
        ).all()
        assert rows == [
            ("legacy-a", hashlib.sha256(b"legacy-a").hexdigest(), 1, 1),
            ("legacy-b%2B%3D", hashlib.sha256(b"legacy-b+=").hexdigest(), 1, 1),
        ]
    for token in ("late-a", "late-b%2B%3D"):
        _insert(engine, token)
    with Session(engine) as db:
        late = db.query(ShareLink).filter(share_token_lookup("late-b+=")).one()
        assert late.share_token == "late-b%2B%3D"
        assert late.token_hash is None and late.token_version == 1
        assert (
            db.query(ShareLink).filter(share_token_lookup("unrecorded")).first() is None
        )
    with engine.begin() as db:
        rows = db.execute(
            text(
                "SELECT token_hash,token_version FROM share_links WHERE id > 2 ORDER BY id"
            )
        ).all()
        assert rows == [(None, 1), (None, 1)]
        migration = _load_migration(Operations(MigrationContext.configure(db)))
        migration.downgrade()
    columns = {column["name"] for column in inspect(engine).get_columns("share_links")}
    assert not columns.intersection({"token_hash", "token_version"})
    with engine.connect() as db:
        assert db.execute(text("SELECT COUNT(*) FROM share_links")).scalar_one() == 4
    print("MySQL: legacy URLs, old-writer inserts, upgrade and rollback preserved")


def main() -> None:
    url = make_url(os.environ["SHARE_TOKEN_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host != "127.0.0.1":
        raise ValueError("An explicit disposable loopback MySQL URL is required")
    name = "test_secure_share_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    try:
        with admin.connect() as db:
            db.exec_driver_sql(f"CREATE DATABASE `{name}`")
        engine = create_engine(url.set(database=name))
        verify(engine)
    finally:
        if engine is not None:
            engine.dispose()
        with admin.connect() as db:
            db.exec_driver_sql(f"DROP DATABASE IF EXISTS `{name}`")
        admin.dispose()


if __name__ == "__main__":
    main()
