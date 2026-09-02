# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prevent startup entry points from bypassing the Backend supervisor."""

import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import textwrap
import time
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ENTRYPOINTS = (
    "backend/start.sh",
    "start.sh",
    "docker/standalone/start.sh",
    "docker/backend/Dockerfile",
    "scripts/run-e2e-local.sh",
    ".github/workflows/test.yml",
    ".github/workflows/e2e-tests.yml",
    "wework/e2e/desktop/modules/cloud-environment.mjs",
)

READINESS_ENTRYPOINTS = {
    "start.sh": 'check_service_health "backend" $BACKEND_PORT "/api/ready"',
    "docker/standalone/start.sh": (
        'wait_for_http "Backend" "http://localhost:${BACKEND_PORT}/api/ready"'
    ),
    "docker/backend/Dockerfile": ("curl -fsS http://localhost:${PORT}/api/ready"),
    "docker-compose.yml": "http://localhost:8000/api/ready",
    "docker-compose.e2e.yml": "http://localhost:8000/api/ready",
    "scripts/run-e2e-local.sh": "curl -fsS http://localhost:8000/api/ready",
    ".github/workflows/test.yml": "curl -fsS http://localhost:8000/api/ready",
    ".github/workflows/e2e-tests.yml": ("wait_for_url http://localhost:8000/api/ready"),
    "wework/e2e/desktop/modules/cloud-environment.mjs": (
        "`${this.backendUrl}/api/ready`"
    ),
}

_SIGNAL_PROBE_CHILD = textwrap.dedent(
    """
    import os
    import signal
    import sys
    import time
    from pathlib import Path

    log_path = Path(sys.argv[1])

    def record(event: str) -> None:
        with log_path.open("a", encoding="utf-8") as log:
            log.write(
                f"{event}|{os.getpid()}|{os.getpgrp()}|{time.monotonic_ns()}\\n"
            )

    def handle_term(_signum, _frame) -> None:
        record("child_term")
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, handle_term)
    record("child_ready")
    while True:
        signal.pause()
    """
)

_SIGNAL_PROBE_SUPERVISOR = textwrap.dedent(
    """
    import os
    import signal
    import subprocess
    import sys
    import time
    from pathlib import Path

    log_path = Path(sys.argv[1])
    ready_path = Path(sys.argv[2])
    child_source = sys.argv[3]
    child = subprocess.Popen([sys.executable, "-c", child_source, str(log_path)])

    def record(event: str) -> None:
        with log_path.open("a", encoding="utf-8") as log:
            log.write(
                f"{event}|{os.getpid()}|{os.getpgrp()}|{time.monotonic_ns()}\\n"
            )

    def handle_term(_signum, _frame) -> None:
        record("supervisor_term")
        time.sleep(0.3)
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
            child.wait(timeout=2)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, handle_term)
    deadline = time.monotonic() + 2
    while "child_ready" not in log_path.read_text(encoding="utf-8"):
        if time.monotonic() >= deadline:
            raise RuntimeError("signal probe child did not start")
        time.sleep(0.01)
    record("supervisor_ready")
    ready_path.touch()
    while True:
        signal.pause()
    """
)


def test_backend_entrypoints_use_runtime_supervisor() -> None:
    for relative_path in BACKEND_ENTRYPOINTS:
        content = (REPOSITORY_ROOT / relative_path).read_text()

        assert "app.runtime" in content, relative_path
        assert "uvicorn app.main:app" not in content, relative_path
        assert "'app.main:app'" not in content, relative_path


def test_shell_entrypoints_exec_the_virtualenv_supervisor() -> None:
    root_start = REPOSITORY_ROOT / "start.sh"
    backend_start = REPOSITORY_ROOT / "backend" / "start.sh"

    assert stat.S_IMODE(root_start.stat().st_mode) & stat.S_IXUSR
    assert stat.S_IMODE(backend_start.stat().st_mode) & stat.S_IXUSR

    root_content = root_start.read_text()
    backend_content = backend_start.read_text()
    assert (
        'exec \\"$SCRIPT_DIR/backend/.venv/bin/python\\" -m app.dev_runtime'
        in root_content
    )
    assert 'BACKEND_PYTHON="$(pwd)/.venv/bin/python"' in backend_content
    assert 'exec "$BACKEND_PYTHON" -m app.dev_runtime' in backend_content
    assert "exec uv run --no-sync python -m app.runtime" not in root_content
    assert "exec uv run --no-sync python -m app.runtime" not in backend_content

    dependency_sync = root_content.split("sync_python_deps()", maxsplit=1)[1].split(
        "check_python_env()", maxsplit=1
    )[0]
    assert 'if [ ! -d ".venv" ]; then' in dependency_sync
    assert "uv sync --frozen" in dependency_sync
    root_start_flow = root_content.split("start_services()", maxsplit=1)[1]
    assert root_start_flow.index('sync_python_deps "backend" "Backend"') < (
        root_start_flow.index(
            'exec \\"$SCRIPT_DIR/backend/.venv/bin/python\\" -m app.dev_runtime'
        )
    )

    assert backend_content.index('if [ ! -d ".venv" ]; then') < (
        backend_content.index('BACKEND_PYTHON="$(pwd)/.venv/bin/python"')
    )
    assert backend_content.index('uv sync --python "$PYTHON_EXEC"') < (
        backend_content.index('BACKEND_PYTHON="$(pwd)/.venv/bin/python"')
    )
    assert 'if [ ! -x "$BACKEND_PYTHON" ]; then' in backend_content


def test_backend_entrypoints_wait_for_real_readiness() -> None:
    for relative_path, expected in READINESS_ENTRYPOINTS.items():
        content = (REPOSITORY_ROOT / relative_path).read_text()

        assert expected in content, relative_path


def test_root_start_assigns_services_to_killable_process_groups() -> None:
    content = (REPOSITORY_ROOT / "start.sh").read_text()
    start_service = content.split("start_service()", maxsplit=1)[1].split(
        "check_service_health()", maxsplit=1
    )[0]

    assert "set -m" in start_service
    assert 'nohup bash -c "$cmd"' in start_service
    assert "local pid=$!" in start_service
    assert "set +m" in start_service

    stop_services = content.split("stop_services()", maxsplit=1)[1].split(
        "start_service()", maxsplit=1
    )[0]
    assert '[[ " ${services[*]} " == *" backend "* ]]' in stop_services
    assert "max_wait=$((backend_grace_period + 10))" in stop_services

    backend_graceful_branch = stop_services.split(
        'if [ "$service" = "backend" ]; then', maxsplit=1
    )[1].split("else", maxsplit=1)[0]
    assert 'kill -TERM "$pid"' in backend_graceful_branch
    assert 'kill -TERM -- -"$pid"' not in backend_graceful_branch
    assert 'if [ "$all_stopped" != "true" ]; then' in stop_services
    assert 'kill -KILL -- -"$pid"' in stop_services


def _wait_for_path(path: Path, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 3
    while not path.exists():
        if process.poll() is not None:
            raise AssertionError(
                f"signal probe exited before readiness: {process.returncode}"
            )
        if time.monotonic() >= deadline:
            raise AssertionError("signal probe did not become ready")
        time.sleep(0.01)


def _unused_tcp_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def test_root_graceful_stop_signals_only_runtime_supervisor_first(
    tmp_path: Path,
) -> None:
    probe_root = tmp_path / "repo"
    probe_root.mkdir()
    start_script = probe_root / "start.sh"
    shutil.copy2(REPOSITORY_ROOT / "start.sh", start_script)
    pid_dir = probe_root / ".pids"
    pid_dir.mkdir()
    signal_log = probe_root / "signals.log"
    signal_log.touch()
    ready_path = probe_root / "ready"

    supervisor = subprocess.Popen(
        [
            sys.executable,
            "-c",
            _SIGNAL_PROBE_SUPERVISOR,
            str(signal_log),
            str(ready_path),
            _SIGNAL_PROBE_CHILD,
        ],
        start_new_session=True,
        text=True,
    )
    try:
        _wait_for_path(ready_path, supervisor)
        (pid_dir / "backend.pid").write_text(str(supervisor.pid))
        (pid_dir / "backend.port").write_text(str(_unused_tcp_port()))
        environment = os.environ.copy()
        environment["GRACEFUL_SHUTDOWN_TIMEOUT"] = "1"

        stop_process = subprocess.Popen(
            [str(start_script), "--stop", "backend", "--graceful"],
            cwd=probe_root,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert supervisor.wait(timeout=3) == 0
        stdout, stderr = stop_process.communicate(timeout=5)

        assert stop_process.returncode == 0, stdout + stderr
        records = [line.split("|") for line in signal_log.read_text().splitlines()]
        events = [record[0] for record in records]
        assert events.count("supervisor_term") == 1
        assert events.count("child_term") == 1
        supervisor_term = next(
            int(record[3]) for record in records if record[0] == "supervisor_term"
        )
        child_term = next(
            int(record[3]) for record in records if record[0] == "child_term"
        )
        assert child_term - supervisor_term >= 200_000_000
        supervisor_ready = next(
            record for record in records if record[0] == "supervisor_ready"
        )
        assert int(supervisor_ready[1]) == supervisor.pid
        assert int(supervisor_ready[2]) == supervisor.pid
    finally:
        if supervisor.poll() is None:
            try:
                os.killpg(supervisor.pid, signal.SIGKILL)
            except (PermissionError, ProcessLookupError):
                pass
        supervisor.wait(timeout=2)


def test_compose_allows_runtime_to_finish_graceful_shutdown() -> None:
    content = (REPOSITORY_ROOT / "docker-compose.yml").read_text()

    assert "stop_grace_period: ${BACKEND_STOP_GRACE_PERIOD:-610s}" in content
