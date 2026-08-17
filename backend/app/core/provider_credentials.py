# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Encrypted provider credentials stored with cloud project metadata."""

import base64
import hashlib
import os
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings
from shared.utils.crypto import (
    CryptoConfigurationError,
    decrypt_sensitive_data,
)

TOKEN_KEY = "token"
CREDENTIAL_KEY = "credential"
CREDENTIAL_VERSION = 2
CREDENTIAL_ALGORITHM = "aes-256-gcm"
LEGACY_CREDENTIAL_VERSION = 1
LEGACY_CREDENTIAL_ALGORITHM = "aes-256-cbc"
NONCE_BYTES = 12


def store_provider_config(
    task_provider: str,
    replacement: dict[str, object],
    current: dict[str, object] | None = None,
) -> dict[str, object]:
    """Normalize provider config and encrypt a supplied token."""
    config = dict(replacement)
    if CREDENTIAL_KEY in config:
        raise ValueError("encrypted provider credentials cannot be supplied")
    config.pop("credential_configured", None)
    token_supplied = TOKEN_KEY in config
    token = config.pop(TOKEN_KEY, None)
    if token is not None and not isinstance(token, str):
        raise ValueError("provider token must be a string")

    if not token_supplied and current:
        _preserve_credential(task_provider, current, config)
        return config

    normalized_token = token.strip() if isinstance(token, str) else ""
    if normalized_token and normalized_token != "***":
        config[CREDENTIAL_KEY] = _encrypt_provider_token(
            normalized_token,
            _credential_context(task_provider, config),
        )
    return config


def mask_provider_config(provider_config: object) -> dict[str, object]:
    """Return non-sensitive provider settings for normal project responses."""
    if not isinstance(provider_config, dict):
        return {}
    config = dict(provider_config)
    configured = isinstance(config.get(CREDENTIAL_KEY), dict)
    config.pop(TOKEN_KEY, None)
    config.pop(CREDENTIAL_KEY, None)
    config["credential_configured"] = configured
    return config


def decrypt_provider_token(task_provider: str, provider_config: object) -> str | None:
    """Decrypt a stored cloud project provider token."""
    if not isinstance(provider_config, dict):
        return None
    credential = provider_config.get(CREDENTIAL_KEY)
    if not isinstance(credential, dict):
        return None
    version = credential.get("version")
    algorithm = credential.get("algorithm")
    if (
        version == LEGACY_CREDENTIAL_VERSION
        and algorithm == LEGACY_CREDENTIAL_ALGORITHM
    ):
        return _decrypt_legacy_provider_token(credential)
    if version != CREDENTIAL_VERSION or algorithm != CREDENTIAL_ALGORITHM:
        raise ValueError("unsupported provider credential format")
    nonce = credential.get("nonce")
    ciphertext = credential.get("ciphertext")
    context = credential.get("context")
    expected_context = _credential_context(task_provider, provider_config)
    if not isinstance(nonce, str) or not nonce:
        raise ValueError("provider credential nonce is required")
    if not isinstance(ciphertext, str) or not ciphertext:
        raise ValueError("provider credential ciphertext is required")
    if not isinstance(context, str) or context != expected_context:
        raise ValueError("provider credential context does not match project")
    try:
        token = AESGCM(_provider_credential_key()).decrypt(
            base64.b64decode(nonce, validate=True),
            base64.b64decode(ciphertext, validate=True),
            context.encode("utf-8"),
        )
    except (InvalidTag, ValueError) as exc:
        raise ValueError("provider credential decryption failed") from exc
    if not token:
        raise ValueError("provider credential decryption failed")
    return token.decode("utf-8")


def _preserve_credential(
    task_provider: str,
    current: dict[str, object],
    replacement: dict[str, object],
) -> None:
    credential = current.get(CREDENTIAL_KEY)
    if not isinstance(credential, dict):
        return
    if _credential_context(task_provider, current) != _credential_context(
        task_provider, replacement
    ):
        raise ValueError("provider token is required when repository or domain changes")
    replacement[CREDENTIAL_KEY] = credential


def _credential_context(task_provider: str, config: dict[str, Any]) -> str:
    repository = str(config.get("repository") or "").strip()
    default_domain = "github.com" if task_provider == "github" else "gitlab.com"
    domain = str(config.get("domain") or default_domain).strip()
    return f"{task_provider}:{domain}:{repository}"


def _provider_credential_key() -> bytes:
    material = f"wegent-cloud-project-provider:{settings.SECRET_KEY}".encode("utf-8")
    return hashlib.sha256(material).digest()


def _encrypt_provider_token(token: str, context: str) -> dict[str, object]:
    nonce = os.urandom(NONCE_BYTES)
    ciphertext = AESGCM(_provider_credential_key()).encrypt(
        nonce,
        token.encode("utf-8"),
        context.encode("utf-8"),
    )
    return {
        "version": CREDENTIAL_VERSION,
        "algorithm": CREDENTIAL_ALGORITHM,
        "context": context,
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }


def _decrypt_legacy_provider_token(credential: dict[str, object]) -> str:
    ciphertext = credential.get("ciphertext")
    if not isinstance(ciphertext, str) or not ciphertext:
        raise ValueError("provider credential ciphertext is required")
    try:
        token = decrypt_sensitive_data(ciphertext)
    except CryptoConfigurationError as exc:
        raise ValueError(
            "legacy provider credentials require GIT_TOKEN_AES_KEY and "
            "GIT_TOKEN_AES_IV"
        ) from exc
    if not token or token == ciphertext:
        raise ValueError("provider credential decryption failed")
    return token
