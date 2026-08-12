# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Encryption for repository webhook verification secrets."""

import base64
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

NONCE_BYTES = 12
CONTEXT = b"wegent-repository-webhook-secret:v1"


def encrypt_webhook_secret(secret: str) -> str:
    if not secret:
        raise ValueError("webhook secret is required")
    nonce = os.urandom(NONCE_BYTES)
    ciphertext = AESGCM(_key()).encrypt(nonce, secret.encode("utf-8"), CONTEXT)
    return base64.b64encode(nonce + ciphertext).decode("ascii")


def decrypt_webhook_secret(ciphertext: str) -> str:
    try:
        payload = base64.b64decode(ciphertext, validate=True)
        if len(payload) <= NONCE_BYTES:
            raise ValueError("invalid webhook secret payload")
        plaintext = AESGCM(_key()).decrypt(
            payload[:NONCE_BYTES],
            payload[NONCE_BYTES:],
            CONTEXT,
        )
    except (InvalidTag, ValueError) as exc:
        raise ValueError("webhook secret decryption failed") from exc
    return plaintext.decode("utf-8")


def _key() -> bytes:
    material = f"wegent-repository-webhook:{settings.SECRET_KEY}".encode("utf-8")
    return hashlib.sha256(material).digest()
