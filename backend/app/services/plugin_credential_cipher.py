"""Authenticated encryption dedicated to account-owned plugin credentials."""

import base64
import binascii
import json
import os
import re
from dataclasses import dataclass, field
from typing import Mapping

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class PluginCredentialCipherError(RuntimeError):
    """A safe error that never includes keys, ciphertext, or plaintext."""


@dataclass(frozen=True)
class PluginCredentialCipher:
    """Use a fresh nonce and bind every value to its owner and connection."""

    active_key_id: str
    keys: Mapping[str, bytes] = field(repr=False)

    def __post_init__(self) -> None:
        if (
            not self.keys
            or self.active_key_id not in self.keys
            or any(not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", k) for k in self.keys)
            or any(len(value) != 32 for value in self.keys.values())
        ):
            raise PluginCredentialCipherError("Plugin credential keyring is invalid")

    @classmethod
    def from_environment(cls) -> "PluginCredentialCipher":
        """Fail closed without affecting unrelated device or task services."""
        from app.core.config import settings

        try:
            encoded = json.loads(
                settings.WEWORK_PLUGIN_CREDENTIAL_KEYS.get_secret_value()
            )
            active = settings.WEWORK_PLUGIN_CREDENTIAL_ACTIVE_KEY_ID
            if not isinstance(encoded, dict):
                raise ValueError
            keys = {
                key: base64.b64decode(value, validate=True)
                for key, value in encoded.items()
            }
            return cls(active, keys)
        except (KeyError, TypeError, ValueError, binascii.Error):
            raise PluginCredentialCipherError(
                "Plugin credential keyring is not configured correctly"
            ) from None

    def encrypt(self, plaintext: str, *, context: str) -> dict[str, str | int]:
        nonce = os.urandom(12)
        ciphertext = AESGCM(self.keys[self.active_key_id]).encrypt(
            nonce, plaintext.encode("utf-8"), self._aad(context, self.active_key_id)
        )
        return {
            "version": 1,
            "keyId": self.active_key_id,
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        }

    def decrypt(self, envelope: dict, *, context: str) -> str:
        try:
            if type(envelope.get("version")) is not int or envelope["version"] != 1:
                raise ValueError
            key_id = envelope["keyId"]
            nonce = base64.b64decode(envelope["nonce"], validate=True)
            if len(nonce) != 12:
                raise ValueError
            ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
            return (
                AESGCM(self.keys[key_id])
                .decrypt(nonce, ciphertext, self._aad(context, key_id))
                .decode("utf-8")
            )
        except (KeyError, TypeError, ValueError, InvalidTag, binascii.Error):
            raise PluginCredentialCipherError(
                "Plugin credential could not be authenticated"
            ) from None

    @staticmethod
    def _aad(context: str, key_id: str) -> bytes:
        return json.dumps(
            ["wegent-plugin-credential", 1, key_id, context],
            separators=(",", ":"),
        ).encode("utf-8")
