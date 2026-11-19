"""Exercise share lookup support in both SQLite fixture modes."""

import hashlib
from pathlib import Path

import pytest
from sqlalchemy import text

from tests import conftest


@pytest.mark.unit
@pytest.mark.parametrize("worker_id", ["master", "gw0"])
def test_share_hash_functions_are_registered_on_every_connection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, worker_id: str
) -> None:
    db_url = (
        "sqlite:///:memory:"
        if worker_id == "master"
        else f"sqlite:///{tmp_path / 'share-fixture.db'}"
    )
    monkeypatch.setattr(conftest, "get_test_database_url", lambda _: db_url)
    fixture = conftest.test_engine.__wrapped__(worker_id)
    engine = next(fixture)
    try:
        # NullPool opens a fresh file connection each time; StaticPool reuses
        # the in-memory connection. Both modes must support the same expression.
        for _ in range(2):
            with engine.connect() as connection:
                digest = connection.scalar(
                    text(
                        "SELECT sha2(replace(replace(:token, '%2B', '+'), '%3D', '='), 256)"
                    ),
                    {"token": "legacy%2Btoken%3D"},
                )
                assert digest == hashlib.sha256(b"legacy+token=").hexdigest()
                assert connection.scalar(text("SELECT sha2(NULL, 256)")) is None
                assert connection.scalar(text("SELECT sha2('token', 512)")) is None
                expected_journal = "memory" if worker_id == "master" else "wal"
                assert (
                    connection.scalar(text("PRAGMA journal_mode")) == expected_journal
                )
    finally:
        with pytest.raises(StopIteration):
            next(fixture)
