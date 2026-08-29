# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authenticated encryption for project event-subscription webhook secrets."""

import base64
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

CREDENTIAL_VERSION = 1
CREDENTIAL_ALGORITHM = "aes-256-gcm"
NONCE_BYTES = 12


def encrypt_subscription_secret(
    secret: str,
    *,
    project_id: str,
    subscription_id: str,
) -> dict[str, object]:
    context = _credential_context(project_id, subscription_id)
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


def decrypt_subscription_secret(
    credential: object,
    *,
    project_id: str,
    subscription_id: str,
) -> str:
    if not isinstance(credential, dict):
        raise ValueError("unsupported event subscription credential format")
    if (
        credential.get("version") != CREDENTIAL_VERSION
        or credential.get("algorithm") != CREDENTIAL_ALGORITHM
    ):
        raise ValueError("unsupported event subscription credential format")
    context = credential.get("context")
    expected_context = _credential_context(project_id, subscription_id)
    if context != expected_context:
        raise ValueError("event subscription credential context does not match")
    nonce = credential.get("nonce")
    ciphertext = credential.get("ciphertext")
    if not isinstance(nonce, str) or not isinstance(ciphertext, str):
        raise ValueError("event subscription credential is incomplete")
    try:
        plaintext = AESGCM(_credential_key()).decrypt(
            base64.b64decode(nonce, validate=True),
            base64.b64decode(ciphertext, validate=True),
            expected_context.encode("utf-8"),
        )
    except (InvalidTag, ValueError) as exc:
        raise ValueError("event subscription credential decryption failed") from exc
    return plaintext.decode("utf-8")


def _credential_context(project_id: str, subscription_id: str) -> str:
    return f"project-event-subscription:{project_id}:{subscription_id}"


def _credential_key() -> bytes:
    material = f"wegent-project-event-subscription:{settings.SECRET_KEY}".encode()
    return hashlib.sha256(material).digest()
