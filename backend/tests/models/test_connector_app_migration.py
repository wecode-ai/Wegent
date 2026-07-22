import importlib.util
import logging
from pathlib import Path
from types import ModuleType
from typing import NoReturn

import pytest


def _load_migration() -> ModuleType:
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "alembic"
        / "versions"
        / "20260722_a9b0c1d2e3f4_move_connector_apps_to_kinds.py"
    )
    assert migration_path.exists()

    spec = importlib.util.spec_from_file_location(
        "connector_app_kind_migration", migration_path
    )
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_reencrypt_embedded_iv_raises_on_decryption_failure(
    monkeypatch, caplog
) -> None:
    migration = _load_migration()

    def fail_decrypt(value: str) -> NoReturn:
        raise ValueError(f"invalid ciphertext: {value}")

    monkeypatch.setattr(
        migration,
        "decrypt_sensitive_data_with_embedded_iv",
        fail_decrypt,
    )
    context = "connector_apps.id=1 slug=broken field=provider_headers_encrypted"

    with caplog.at_level(logging.ERROR):
        with pytest.raises(migration.EmbeddedIvReencryptError):
            migration._reencrypt_embedded_iv("bad-ciphertext", context=context)

    assert context in caplog.text
    assert "bad-ciphertext" not in caplog.text
