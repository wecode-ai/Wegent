#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import os
import re
from typing import Protocol

from shared.logger import setup_logger
from shared.utils.crypto import decrypt_sensitive_data, is_data_encrypted

logger = setup_logger("executor_env_value")


class LoggerLike(Protocol):
    def info(self, message: str) -> None: ...

    def warning(self, message: str) -> None: ...


def resolve_env_value(value: str, *, logger_override: LoggerLike | None = None) -> str:
    """Resolve environment placeholders and encrypted sensitive values."""
    active_logger = logger_override or logger
    if not value:
        return value

    env_var_pattern = r"^\$\{([^}]+)\}$"
    match = re.match(env_var_pattern, value)
    if match:
        var_name = match.group(1)
        resolved = os.environ.get(var_name, "")
        if resolved:
            active_logger.info(f"Resolved env var ${{{var_name}}} from environment")
        else:
            active_logger.warning(f"Environment variable {var_name} not found")
        return resolved

    if is_data_encrypted(value):
        decrypted = decrypt_sensitive_data(value)
        if decrypted:
            active_logger.info("Decrypted sensitive data")
            return decrypted
        active_logger.warning("Failed to decrypt sensitive data")
        return ""

    return value
