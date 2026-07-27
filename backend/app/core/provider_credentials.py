# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Encrypted provider credentials stored with cloud project metadata."""

from typing import Any

from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

TOKEN_KEY = "token"
CREDENTIAL_KEY = "credential"
CREDENTIAL_VERSION = 1
CREDENTIAL_ALGORITHM = "aes-256-cbc"


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
        config[CREDENTIAL_KEY] = {
            "version": CREDENTIAL_VERSION,
            "algorithm": CREDENTIAL_ALGORITHM,
            "ciphertext": encrypt_sensitive_data(normalized_token),
        }
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


def decrypt_provider_token(provider_config: object) -> str | None:
    """Decrypt a stored cloud project provider token."""
    if not isinstance(provider_config, dict):
        return None
    credential = provider_config.get(CREDENTIAL_KEY)
    if not isinstance(credential, dict):
        return None
    if credential.get("version") != CREDENTIAL_VERSION:
        raise ValueError("unsupported provider credential version")
    if credential.get("algorithm") != CREDENTIAL_ALGORITHM:
        raise ValueError("unsupported provider credential algorithm")
    ciphertext = credential.get("ciphertext")
    if not isinstance(ciphertext, str) or not ciphertext:
        raise ValueError("provider credential ciphertext is required")
    token = decrypt_sensitive_data(ciphertext)
    if not token or token == ciphertext:
        raise ValueError("provider credential decryption failed")
    return token


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
