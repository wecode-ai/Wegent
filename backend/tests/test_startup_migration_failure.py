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


async def test_rust_owned_initialization_does_not_run_python_initializers(
    monkeypatch, isolated_lifespan
):
    import app.main as main
    from app.services.builtin_plugin_service import builtin_plugin_service

    monkeypatch.setattr(main.settings, "DB_INITIALIZATION_OWNER", "rust")
    lock_client = MagicMock()
    monkeypatch.setattr(main.redis, "from_url", lock_client)
    initialize = MagicMock()
    monkeypatch.setattr(main, "run_yaml_initialization", initialize)
    publish = MagicMock()
    monkeypatch.setattr(builtin_plugin_service, "sync_marketplace_plugins", publish)

    async with isolated_lifespan(FastAPI()):
        initialize.assert_not_called()
        publish.assert_not_called()
    lock_client.assert_not_called()
