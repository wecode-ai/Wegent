"""Deadlock handling for the official plugin publication CLI."""

import importlib.util
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session


def _load_script() -> ModuleType:
    path = Path(__file__).resolve().parents[2] / "scripts/publish_official_plugin.py"
    spec = importlib.util.spec_from_file_location(
        "publish_official_plugin_script", path
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


SCRIPT = _load_script()


@pytest.fixture
def mysql_engine() -> Iterator[Engine]:
    engine = create_engine("mysql+pymysql://unused@127.0.0.1/unused")
    try:
        yield engine
    finally:
        engine.dispose()


def _operational_error(code: int, message: str) -> OperationalError:
    return OperationalError("INSERT INTO plugins", {}, Exception(code, message))


def _args() -> SimpleNamespace:
    return SimpleNamespace(
        slug="desktop-e2e",
        listing_type="plugin",
        visibility="workspace",
        featured_rank=None,
        created_by_user_id=1,
    )


class _Publisher:
    def __init__(self, failures: list[OperationalError]) -> None:
        self.failures = list(failures)
        self.calls = 0

    def publish_package(self, db, **kwargs):
        assert not db.in_transaction()
        assert (
            db.get_bind().get_execution_options()["isolation_level"] == "READ COMMITTED"
        )
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)
        release = SimpleNamespace(plugin_id=7, id=8, storage_key="plugins/desktop-e2e")
        return SimpleNamespace(release=release, created=True)


def _install(
    monkeypatch: pytest.MonkeyPatch, publisher: _Publisher, engine: Engine
) -> list[float]:
    sleeps: list[float] = []
    monkeypatch.setattr(SCRIPT, "official_plugin_publisher", publisher)
    monkeypatch.setattr(SCRIPT, "SessionLocal", lambda: Session(engine))
    monkeypatch.setattr(SCRIPT.time, "sleep", sleeps.append)
    return sleeps


def test_publish_release_retries_mysql_deadlock(monkeypatch, mysql_engine):
    publisher = _Publisher([_operational_error(1213, "Deadlock found")])
    sleeps = _install(monkeypatch, publisher, mysql_engine)

    result = SCRIPT.publish_release(object(), _args(), {"publisher": "ci"})

    assert publisher.calls == 2
    assert result.release.plugin_id == 7
    assert sleeps == [0.2]


def test_publish_release_stops_after_retry_budget(monkeypatch, mysql_engine):
    failures = [_operational_error(1213, "Deadlock found") for _ in range(3)]
    publisher = _Publisher(failures)
    _install(monkeypatch, publisher, mysql_engine)

    with pytest.raises(OperationalError):
        SCRIPT.publish_release(object(), _args(), {"publisher": "ci"})

    assert publisher.calls == 3


def test_publish_release_propagates_other_operational_errors(monkeypatch, mysql_engine):
    publisher = _Publisher([_operational_error(1205, "Lock wait timeout")])
    _install(monkeypatch, publisher, mysql_engine)

    with pytest.raises(OperationalError):
        SCRIPT.publish_release(object(), _args(), {"publisher": "ci"})

    assert publisher.calls == 1


@pytest.mark.parametrize("prebuilt", [False, True])
def test_publisher_configures_mysql_before_catalog_access(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    prebuilt: bool,
) -> None:
    engine = create_engine("mysql+pymysql://unused@127.0.0.1/unused")
    db = Session(engine)
    built = SimpleNamespace(
        name="fixture", version="1.0.0", sha256="a" * 64, size_bytes=7
    )
    publisher = Mock()
    publisher.build_package.return_value = built
    publisher.load_archive.return_value = built

    def publish(session: Session, **kwargs: Any) -> SimpleNamespace:
        assert session is db
        assert not session.in_transaction()
        assert session.get_bind().get_execution_options()["isolation_level"] == (
            "READ COMMITTED"
        )
        assert kwargs["built"] is built
        return SimpleNamespace(
            release=SimpleNamespace(plugin_id=1, id=2, storage_key="fixture.zip"),
            created=True,
        )

    publisher.publish_package.side_effect = publish
    monkeypatch.setattr(SCRIPT, "SessionLocal", lambda: db)
    monkeypatch.setattr(SCRIPT, "official_plugin_publisher", publisher)
    monkeypatch.setattr(
        "sys.argv",
        ["publish_official_plugin.py", str(tmp_path)]
        + (["--prebuilt", "--sha256", built.sha256] if prebuilt else []),
    )
    try:
        assert SCRIPT.main() == 0
        assert json.loads(capsys.readouterr().out)["releaseId"] == 2
        publisher.publish_package.assert_called_once()
    finally:
        db.close()
        engine.dispose()
