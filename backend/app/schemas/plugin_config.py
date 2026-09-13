# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validation for non-secret Plugin configuration persisted in execution intent."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

_CAMEL_CASE_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]+")
_PRIVATE_KEY_VALUE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----",
    re.IGNORECASE,
)
_SENSITIVE_CONFIG_KEYS = {
    "api_key",
    "apikey",
    "app_secret",
    "auth_token",
    "authorization",
    "bearer_token",
    "client_secret",
    "credential",
    "credentials",
    "password",
    "passwd",
    "private_key",
    "private_key_pem",
    "pwd",
    "refresh_token",
    "secret",
    "signing_key",
    "token",
}
_SENSITIVE_KEY_SUFFIXES = (
    "_api_key",
    "_auth_token",
    "_credential",
    "_credentials",
    "_password",
    "_private_key",
    "_secret",
    "_token",
)


def validate_non_secret_plugin_configs(
    plugins: object,
    *,
    field_name: str,
) -> None:
    """Reject credentials from Plugin config before execution intent is persisted."""

    if plugins is None:
        return
    if not isinstance(plugins, Sequence) or isinstance(plugins, (str, bytes)):
        raise ValueError(f"{field_name} must be a list")
    for index, plugin in enumerate(plugins):
        plugin_path = f"{field_name}[{index}]"
        if not isinstance(plugin, Mapping):
            raise ValueError(f"{plugin_path} must be an object")
        config = plugin.get("config")
        if config is not None:
            if not isinstance(config, Mapping):
                raise ValueError(f"{plugin_path}.config must be an object")
            _validate_non_secret_json(config, path=f"{plugin_path}.config")
        credential_refs = plugin.get("credential_refs", plugin.get("credentialRefs"))
        if credential_refs is not None:
            _validate_credential_refs(credential_refs, path=plugin_path)


def _validate_non_secret_json(value: object, *, path: str) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{path} keys must be strings")
            child_path = f"{path}.{key}"
            if _is_sensitive_config_key(key):
                raise ValueError(
                    f"{child_path} must not contain credentials; use credential_refs"
                )
            _validate_non_secret_json(child, path=child_path)
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for index, child in enumerate(value):
            _validate_non_secret_json(child, path=f"{path}[{index}]")
        return
    if isinstance(value, str) and _PRIVATE_KEY_VALUE.search(value):
        raise ValueError(
            f"{path} must not contain private key material; use credential_refs"
        )
    if value is not None and not isinstance(value, (str, int, float, bool)):
        raise ValueError(f"{path} must contain JSON values only")


def _validate_credential_refs(value: object, *, path: str) -> None:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ValueError(f"{path}.credential_refs must be a list")
    for index, credential_ref in enumerate(value):
        ref_path = f"{path}.credential_refs[{index}]"
        if not isinstance(credential_ref, Mapping):
            raise ValueError(f"{ref_path} must be an object")
        for field in ("name", "ref"):
            field_value = credential_ref.get(field)
            if not isinstance(field_value, str) or not field_value.strip():
                raise ValueError(f"{ref_path}.{field} must be a non-empty string")


def _is_sensitive_config_key(key: str) -> bool:
    snake_case = _CAMEL_CASE_BOUNDARY.sub(r"\1_\2", key)
    normalized = _NON_ALPHANUMERIC.sub("_", snake_case.lower()).strip("_")
    return (
        normalized in _SENSITIVE_CONFIG_KEYS
        or "private_key" in normalized
        or normalized.endswith(_SENSITIVE_KEY_SUFFIXES)
    )
