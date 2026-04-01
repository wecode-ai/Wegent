# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from typing import Any

SENSITIVE_CONFIG_KEYS = (
    "api_key",
    "authorization",
    "token",
    "secret",
    "password",
)


def _mask_sensitive_data(value: Any, parent_key: str | None = None) -> Any:
    if isinstance(value, dict):
        return {
            key: _mask_sensitive_data(child, parent_key=key)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [_mask_sensitive_data(item, parent_key=parent_key) for item in value]
    if isinstance(value, str):
        key_name = (parent_key or "").lower()
        if any(secret_key in key_name for secret_key in SENSITIVE_CONFIG_KEYS):
            return "***"
    return value


def safe_model_config_for_logging(model_config: dict[str, Any]) -> str:
    return json.dumps(_mask_sensitive_data(model_config), ensure_ascii=False)


__all__ = ["safe_model_config_for_logging"]
