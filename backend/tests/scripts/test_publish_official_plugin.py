"""CLI publication uses the same transaction isolation as plugin requests."""

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from scripts import publish_official_plugin as script


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
    monkeypatch.setattr(script, "SessionLocal", lambda: db)
    monkeypatch.setattr(script, "official_plugin_publisher", publisher)
    monkeypatch.setattr(
        "sys.argv",
        ["publish_official_plugin.py", str(tmp_path)]
        + (["--prebuilt", "--sha256", built.sha256] if prebuilt else []),
    )
    try:
        assert script.main() == 0
        assert json.loads(capsys.readouterr().out)["releaseId"] == 2
        publisher.publish_package.assert_called_once()
    finally:
        db.close()
        engine.dispose()
