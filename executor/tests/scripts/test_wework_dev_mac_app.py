# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
WEWORK_SCRIPTS_DIR = PROJECT_ROOT / "wework" / "scripts"


def test_dev_mac_app_defaults_to_source_reload_executor_sidecar():
    script = (WEWORK_SCRIPTS_DIR / "dev-mac-app.sh").read_text(encoding="utf-8")

    assert 'WEWORK_EXECUTOR_SIDECAR="$WEWORK_DIR/scripts/dev-executor-sidecar.sh"' in script
    assert "executor/dist/wegent-executor" not in script


def test_dev_executor_sidecar_runs_executor_source_with_reload():
    wrapper = WEWORK_SCRIPTS_DIR / "dev-executor-sidecar.sh"
    supervisor = PROJECT_ROOT / "executor" / "scripts" / "dev_sidecar.py"

    assert wrapper.exists()
    assert supervisor.exists()
    assert "scripts/dev_sidecar.py" in wrapper.read_text(encoding="utf-8")

    supervisor_source = supervisor.read_text(encoding="utf-8")
    assert "watchdog.observers" in supervisor_source
    assert "main.py" in supervisor_source
