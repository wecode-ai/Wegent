# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated encryption for project automation webhook secrets."""

import base64
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

CREDENTIAL_VERSION = 1
CREDENTIAL_ALGORITHM = "aes-256-gcm"
NONCE_BYTES = 12


def encrypt_webhook_secret(
    secret: str, *, project_id: str, automation_id: str
) -> dict[str, object]:
    """Encrypt a webhook secret and bind it to its owning automation."""
    context = _credential_context(project_id, automation_id)
    nonce = os.urandom(NONCE_BYTES)
    ciphertext = AESGCM(_credential_key()).encrypt(
        nonce,
        secret.encode("utf-8"),
        context.encode("utf-8"),
    )
    return {
        "version": CREDENTIAL_VERSION,
        "algorithm": CREDENTIAL_ALGORITHM,
        "context": context,
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }


def decrypt_webhook_secret(
    credential: object, *, project_id: str, automation_id: str
) -> str:
    """Decrypt a webhook secret after authenticating its owner and contents."""
    if not isinstance(credential, dict):
        raise ValueError("unsupported project automation credential format")
    if (
        credential.get("version") != CREDENTIAL_VERSION
        or credential.get("algorithm") != CREDENTIAL_ALGORITHM
    ):
        raise ValueError("unsupported project automation credential format")

    context = credential.get("context")
    nonce = credential.get("nonce")
    ciphertext = credential.get("ciphertext")
    expected_context = _credential_context(project_id, automation_id)
    if context != expected_context:
        raise ValueError("project automation credential context does not match")
    if not isinstance(nonce, str) or not nonce:
        raise ValueError("project automation credential nonce is required")
    if not isinstance(ciphertext, str) or not ciphertext:
        raise ValueError("project automation credential ciphertext is required")

    try:
        plaintext = AESGCM(_credential_key()).decrypt(
            base64.b64decode(nonce, validate=True),
            base64.b64decode(ciphertext, validate=True),
            context.encode("utf-8"),
        )
    except (InvalidTag, ValueError) as exc:
        raise ValueError("project automation credential decryption failed") from exc
    if not plaintext:
        raise ValueError("project automation credential decryption failed")
    return plaintext.decode("utf-8")


def _credential_context(project_id: str, automation_id: str) -> str:
    return f"project-automation-webhook:{project_id}:{automation_id}"


def _credential_key() -> bytes:
    material = f"wegent-project-automation-webhook:{settings.SECRET_KEY}".encode(
        "utf-8"
    )
    return hashlib.sha256(material).digest()
