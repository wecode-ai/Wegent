# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local CLI runtime configuration helpers."""

import os

LOCAL_CLI_CONFIG_RUNTIMES_ENV = "WEGENT_LOCAL_CLI_CONFIG_RUNTIMES"
SUPPORTED_LOCAL_CLI_CONFIG_RUNTIMES = {"codex"}


def use_local_cli_config(runtime: str) -> bool:
    """Return whether a CLI runtime should use device-local provider config."""
    runtime_name = runtime.strip().lower()
    if runtime_name not in SUPPORTED_LOCAL_CLI_CONFIG_RUNTIMES:
        return False

    raw_value = os.getenv(LOCAL_CLI_CONFIG_RUNTIMES_ENV, "")
    enabled_runtimes = {
        item.strip().lower() for item in raw_value.split(",") if item.strip()
    }
    return runtime_name in enabled_runtimes
