"""Deadlock handling for the official plugin publication CLI."""

import importlib.util
import sys
from contextlib import nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from sqlalchemy.exc import OperationalError


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
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)
        release = SimpleNamespace(plugin_id=7, id=8, storage_key="plugins/desktop-e2e")
        return SimpleNamespace(release=release, created=True)


def _install(monkeypatch: pytest.MonkeyPatch, publisher: _Publisher) -> list[float]:
    sleeps: list[float] = []
    monkeypatch.setattr(SCRIPT, "official_plugin_publisher", publisher)
    monkeypatch.setattr(SCRIPT, "SessionLocal", lambda: nullcontext(object()))
    monkeypatch.setattr(SCRIPT.time, "sleep", sleeps.append)
    return sleeps


def test_publish_release_retries_mysql_deadlock(monkeypatch):
    publisher = _Publisher([_operational_error(1213, "Deadlock found")])
    sleeps = _install(monkeypatch, publisher)

    result = SCRIPT.publish_release(object(), _args(), {"publisher": "ci"})

    assert publisher.calls == 2
    assert result.release.plugin_id == 7
    assert sleeps == [0.2]


def test_publish_release_stops_after_retry_budget(monkeypatch):
    failures = [_operational_error(1213, "Deadlock found") for _ in range(3)]
    publisher = _Publisher(failures)
    _install(monkeypatch, publisher)

    with pytest.raises(OperationalError):
        SCRIPT.publish_release(object(), _args(), {"publisher": "ci"})

    assert publisher.calls == 3


def test_publish_release_propagates_other_operational_errors(monkeypatch):
    publisher = _Publisher([_operational_error(1205, "Lock wait timeout")])
    _install(monkeypatch, publisher)

    with pytest.raises(OperationalError):
        SCRIPT.publish_release(object(), _args(), {"publisher": "ci"})

    assert publisher.calls == 1
