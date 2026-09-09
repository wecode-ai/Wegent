import base64
import json

import pytest
from pydantic import SecretStr

from app.core.config import Settings, settings
from app.services.plugin_credential_cipher import (
    PluginCredentialCipher,
    PluginCredentialCipherError,
)


def test_cipher_uses_random_nonces_and_binds_owner_and_connection():
    cipher = PluginCredentialCipher("v1", {"v1": b"a" * 32})
    first = cipher.encrypt("test-password", context="user-1/mail/account-1")
    second = cipher.encrypt("test-password", context="user-1/mail/account-1")

    assert first != second
    assert "test-password" not in json.dumps(first)
    assert cipher.decrypt(first, context="user-1/mail/account-1") == "test-password"
    for context in [
        "user-2/mail/account-1",
        "user-1/mail/account-2",
        "user-1/chat/account-1",
    ]:
        with pytest.raises(PluginCredentialCipherError):
            cipher.decrypt(first, context=context)


@pytest.mark.parametrize(
    "field,value",
    [
        ("version", 2),
        ("version", True),
        ("keyId", "unknown"),
        ("nonce", "invalid"),
        ("ciphertext", base64.b64encode(b"tampered-value").decode()),
    ],
)
def test_cipher_rejects_tampering_without_leaking_payload(field, value):
    cipher = PluginCredentialCipher("v1", {"v1": b"a" * 32})
    envelope = cipher.encrypt("private-value", context="owner")
    envelope[field] = value
    with pytest.raises(PluginCredentialCipherError) as error:
        cipher.decrypt(envelope, context="owner")
    assert str(error.value) == "Plugin credential could not be authenticated"


def test_rotation_can_read_old_key_and_only_writes_active_key():
    old = PluginCredentialCipher("old", {"old": b"a" * 32})
    rotated = PluginCredentialCipher("new", {"old": b"a" * 32, "new": b"b" * 32})
    envelope = old.encrypt("secret", context="owner")
    assert rotated.decrypt(envelope, context="owner") == "secret"
    assert rotated.encrypt("secret", context="owner")["keyId"] == "new"
    assert "aaaaaaaa" not in repr(rotated)


@pytest.mark.parametrize(
    "keyring,active",
    [
        (None, None),
        ("{}", "v1"),
        ("[]", "v1"),
        ("not-json", "v1"),
        ('{"v1":"invalid"}', "v1"),
        (json.dumps({"v1": base64.b64encode(b"short").decode()}), "v1"),
    ],
)
def test_missing_or_invalid_keyring_fails_closed(monkeypatch, keyring, active):
    monkeypatch.setattr(
        settings, "WEWORK_PLUGIN_CREDENTIAL_KEYS", SecretStr(keyring or "")
    )
    monkeypatch.setattr(
        settings, "WEWORK_PLUGIN_CREDENTIAL_ACTIVE_KEY_ID", active or ""
    )
    with pytest.raises(PluginCredentialCipherError):
        PluginCredentialCipher.from_environment()


def test_loads_explicit_keyring(monkeypatch):
    monkeypatch.setattr(
        settings,
        "WEWORK_PLUGIN_CREDENTIAL_KEYS",
        SecretStr(json.dumps({"v1": base64.b64encode(b"a" * 32).decode()})),
    )
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_CREDENTIAL_ACTIVE_KEY_ID", "v1")
    assert PluginCredentialCipher.from_environment().active_key_id == "v1"


def test_dotenv_keyring_is_loaded_and_redacted(tmp_path, monkeypatch):
    monkeypatch.delenv("WEWORK_PLUGIN_CREDENTIAL_KEYS", raising=False)
    monkeypatch.delenv("WEWORK_PLUGIN_CREDENTIAL_ACTIVE_KEY_ID", raising=False)
    encoded = base64.b64encode(b"a" * 32).decode()
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        f'WEWORK_PLUGIN_CREDENTIAL_KEYS={{"test":"{encoded}"}}\n'
        "WEWORK_PLUGIN_CREDENTIAL_ACTIVE_KEY_ID=test\n"
    )
    config = Settings(_env_file=dotenv)
    assert json.loads(config.WEWORK_PLUGIN_CREDENTIAL_KEYS.get_secret_value()) == {
        "test": encoded
    }
    assert encoded not in repr(config)
