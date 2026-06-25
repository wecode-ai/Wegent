# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path


def test_local_sh_allows_device_config_connection_values():
    script = (Path(__file__).resolve().parents[2] / "local.sh").read_text(
        encoding="utf-8"
    )

    assert "WEGENT_AUTH_TOKEN is required" not in script
    backend_default = (
        'WEGENT_BACKEND_URL="${WEGENT_BACKEND_URL:-http://localhost:8000}"'
    )
    assert backend_default not in script
    assert "overrides device-config.json" in script


def test_local_sh_does_not_set_executor_mode_for_local_defaults():
    script = (Path(__file__).resolve().parents[2] / "local.sh").read_text(
        encoding="utf-8"
    )

    assert 'export EXECUTOR_MODE="${EXECUTOR_MODE:-local}"' not in script
    assert "export EXECUTOR_MODE=local" not in script
    assert "DEVICE_CONFIG_PATH" not in script
