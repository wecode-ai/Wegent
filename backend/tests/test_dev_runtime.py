# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the complete Backend development reloader."""

import signal
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

from watchfiles import Change

from app.dev_runtime import BackendDevelopmentRuntime


def test_dev_runtime_restarts_complete_supervisor_on_python_change(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runtime = BackendDevelopmentRuntime(
        (tmp_path,),
        shutdown_timeout_seconds=7,
    )
    first_process = MagicMock()
    first_process.poll.return_value = None
    second_process = MagicMock()
    second_process.poll.return_value = None
    start_runtime = MagicMock(side_effect=[first_process, second_process])
    stop_runtime = MagicMock()
    monkeypatch.setattr(runtime, "_install_signal_handlers", MagicMock())
    monkeypatch.setattr(runtime, "_start_runtime", start_runtime)
    monkeypatch.setattr(runtime, "_stop_runtime", stop_runtime)
    monkeypatch.setattr(
        "app.dev_runtime.watch",
        lambda *_paths, **_kwargs: iter(
            [{(Change.modified, str(tmp_path / "changed.py"))}]
        ),
    )

    assert runtime.run() == 0

    assert start_runtime.call_count == 2
    assert stop_runtime.call_args_list == [
        ((first_process,),),
        ((second_process,),),
    ]


def test_dev_runtime_stops_supervisor_gracefully(tmp_path: Path) -> None:
    runtime = BackendDevelopmentRuntime(
        (tmp_path,),
        shutdown_timeout_seconds=7,
    )
    process = MagicMock()
    process.poll.return_value = None

    runtime._stop_runtime(process)

    process.send_signal.assert_called_once_with(signal.SIGTERM)
    process.wait.assert_called_once_with(timeout=7)


def test_dev_runtime_force_kills_only_after_drain_timeout(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runtime = BackendDevelopmentRuntime(
        (tmp_path,),
        shutdown_timeout_seconds=7,
    )
    process = MagicMock()
    process.pid = 1234
    process.poll.return_value = None
    process.wait.side_effect = [subprocess.TimeoutExpired("app.runtime", 7), 0]
    killpg = MagicMock()
    monkeypatch.setattr("app.dev_runtime.os.killpg", killpg)

    runtime._stop_runtime(process)

    process.send_signal.assert_called_once_with(signal.SIGTERM)
    killpg.assert_called_once_with(1234, signal.SIGKILL)
    assert process.wait.call_count == 2
