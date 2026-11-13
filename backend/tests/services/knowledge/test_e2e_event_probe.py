# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROBE = Path(__file__).parents[2] / "e2e" / "event_probe"
ROOT = Path(__file__).parents[4]


def _environment(directory: Path) -> dict[str, str]:
    return {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(PROBE), str(ROOT)]),
        "WEGENT_E2E_EVENT_PROBE_DIR": str(directory),
    }


def test_probe_registers_for_real_forked_children(tmp_path: Path) -> None:
    if not hasattr(os, "fork"):
        pytest.skip("fork is unavailable")
    script = """
import os
from shared.event_reporting import emit_event
emit_event(event_type='knowledge.kb.created', kb_id=1)
pid = os.fork()
if pid == 0:
    emit_event(event_type='knowledge.kb.created', kb_id=2)
    os._exit(0)
_, status = os.waitpid(pid, 0)
assert status == 0
"""
    subprocess.run(
        [sys.executable, "-c", script], env=_environment(tmp_path), check=True
    )
    rows = [
        json.loads(row) for row in (tmp_path / "events.jsonl").read_text().splitlines()
    ]
    assert {row["event"]["kb_id"] for row in rows} == {1, 2}
    assert len({row["pid"] for row in rows}) == 2


def test_probe_receiver_exception_does_not_escape(tmp_path: Path) -> None:
    (tmp_path / "fail-receiver").touch()
    script = """
from shared.event_reporting import emit_event
emit_event(event_type='knowledge.kb.created', kb_id=1)
print('business completed')
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=_environment(tmp_path),
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout.strip() == "business completed"
    row = json.loads((tmp_path / "events.jsonl").read_text())
    assert row["injected_failure"] is True
