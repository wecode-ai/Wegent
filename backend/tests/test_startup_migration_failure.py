"""Failed development migrations must stop before application initialization."""

from subprocess import CalledProcessError
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI

from tests.test_main_video_recovery import isolated_lifespan


async def test_migration_failure_stops_startup_and_releases_lock(
    monkeypatch, isolated_lifespan
):
    import app.main as main

    redis_client = MagicMock()
    redis_client.set.return_value = True
    monkeypatch.setattr(main.redis, "from_url", lambda *_args, **_kwargs: redis_client)
    monkeypatch.setattr(main.settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(main.settings, "DB_AUTO_MIGRATE", True)
    initialize = MagicMock()
    monkeypatch.setattr(main, "run_yaml_initialization", initialize)
    monkeypatch.setattr(
        "subprocess.run",
        MagicMock(side_effect=CalledProcessError(1, ["alembic", "upgrade", "head"])),
    )
    with pytest.raises(CalledProcessError):
        async with isolated_lifespan(FastAPI()):
            pytest.fail("Startup must fail before serving requests")
    initialize.assert_not_called()
    redis_client.delete.assert_called_once_with(main.STARTUP_LOCK_KEY)
