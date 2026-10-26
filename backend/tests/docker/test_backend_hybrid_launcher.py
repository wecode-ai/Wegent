# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process-supervision unit tests using executable doubles, without app services."""

import json
import os
import signal
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import pytest

LAUNCHER = (
    Path(__file__).resolve().parents[3] / "backend-rs/scripts/start-hybrid-backend.sh"
)
STUB = """import json, os, signal, socket, sys
from pathlib import Path
role = 'python' if Path(__file__).name.startswith('python') else 'rust'
args = sys.argv[1:]
port = int(args[args.index('--port') + 1] if role == 'python'
           else os.environ['WEGENT_RS_LISTEN_PORT'])
Path(os.environ['FIXTURE_RECORDS'], role + '.json').write_text(json.dumps({
    'pid': os.getpid(), 'cwd': os.getcwd(), 'args': args,
    'upstream': os.environ.get('WEGENT_PYTHON_UPSTREAM_URL'),
    'routes': os.environ.get('WEGENT_RS_ROUTES_FILE'),
    'dotenv': os.environ.get('WEGENT_BACKEND_RS_ENV_FILE'),
}))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
with socket.socket() as server:
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', port))
    server.listen()
    while True:
        connection, _ = server.accept()
        connection.close()
"""


def _environment(tmp_path: Path, *, production: bool) -> dict[str, str]:
    repository = tmp_path / "repository"
    backend = tmp_path / "flat-app" if production else repository / "backend"
    rust = repository / "backend-rs"
    for folder in [backend, rust / "config", repository / "shared"]:
        folder.mkdir(parents=True)
    (backend / ".env.example").write_text("")
    (rust / "config/routes.toml").write_text("")
    for role in ["python", "rust"]:
        executable = tmp_path / f"{role}-stub"
        executable.write_text(f"#!{sys.executable}\n{STUB}")
        executable.chmod(0o755)
    with socket.socket() as public, socket.socket() as upstream:
        public.bind(("127.0.0.1", 0))
        upstream.bind(("127.0.0.1", 0))
        ports = [public.getsockname()[1], upstream.getsockname()[1]]
    env = {
        **os.environ,
        "WEGENT_REPOSITORY_ROOT": str(repository),
        "WEGENT_RS_PROJECT_DIR": str(rust),
        "WEGENT_RS_BINARY_PATH": str(tmp_path / "rust-stub"),
        "WEGENT_PYTHON_UVICORN": str(tmp_path / "python-stub"),
        "WEGENT_RS_LISTEN_HOST": "127.0.0.1",
        "WEGENT_RS_LISTEN_PORT": str(ports[0]),
        "WEGENT_PYTHON_UPSTREAM_PORT": str(ports[1]),
        "WEGENT_HYBRID_STATE_FILE": str(tmp_path / "state"),
        "WEGENT_PYTHON_READY_TIMEOUT": "8",
        "FIXTURE_RECORDS": str(tmp_path),
        "GRACEFUL_SHUTDOWN_TIMEOUT": "7",
    }
    for name in [
        "WEGENT_PYTHON_BACKEND_DIR",
        "WEGENT_PYTHON_RELOAD",
        "WEGENT_RS_ROUTES_FILE",
        "WEGENT_BACKEND_RS_ENV_FILE",
    ]:
        env.pop(name, None)
    if production:
        env.update(WEGENT_PYTHON_BACKEND_DIR=str(backend), WEGENT_PYTHON_RELOAD="false")
    return env


def _wait_ready(process: subprocess.Popen, env: dict[str, str]) -> dict[str, str]:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        assert process.poll() is None, "launcher exited before readiness"
        state_path = Path(env["WEGENT_HYBRID_STATE_FILE"])
        if state_path.exists():
            state = dict(
                line.split("=", 1) for line in state_path.read_text().splitlines()
            )
            if state.get("rust"):
                try:
                    with socket.create_connection(
                        ("127.0.0.1", int(env["WEGENT_RS_LISTEN_PORT"])), timeout=0.1
                    ):
                        return state
                except OSError:
                    pass
        time.sleep(0.02)
    pytest.fail("launcher did not become ready")


@contextmanager
def _launch(tmp_path: Path, *, production: bool = True) -> Iterator[tuple]:
    env = _environment(tmp_path, production=production)
    with (tmp_path / "launcher.log").open("w") as log:
        process = subprocess.Popen(
            ["bash", str(LAUNCHER)], env=env, stdout=log, stderr=log
        )
        try:
            yield process, env, _wait_ready(process, env)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def _assert_stopped(state: dict[str, str], env: dict[str, str]) -> None:
    for role in ["python", "rust"]:
        with pytest.raises(ProcessLookupError):
            os.kill(int(state[role]), 0)
    assert not Path(env["WEGENT_HYBRID_STATE_FILE"]).exists()


@pytest.mark.parametrize("production", [True, False])
def test_launcher_preserves_layout_modes_and_stops_both_children(
    tmp_path: Path, production: bool
) -> None:
    """Container startup uses a prebuilt gateway and no development reloader."""
    with _launch(tmp_path, production=production) as (process, env, state):
        python = json.loads((tmp_path / "python.json").read_text())
        rust = json.loads((tmp_path / "rust.json").read_text())
        args = python["args"]
        assert ("--reload" in args) is not production
        assert args[args.index("--host") + 1] == "127.0.0.1"
        assert args[args.index("--port") + 1] == env["WEGENT_PYTHON_UPSTREAM_PORT"]
        expected = (
            tmp_path / "flat-app" if production else tmp_path / "repository/backend"
        )
        assert python["cwd"] == str(expected)
        assert (
            rust["upstream"] == f"http://127.0.0.1:{env['WEGENT_PYTHON_UPSTREAM_PORT']}"
        )
        assert rust["dotenv"] == str(expected / ".env.example")
        assert rust["routes"] == str(
            tmp_path / "repository/backend-rs/config/routes.toml"
        )
        if production:
            assert args[args.index("--timeout-graceful-shutdown") + 1] == "7"
        assert args[args.index("--log-level") + 1] == (
            "info" if production else "debug"
        )
        process.terminate()
        assert process.wait(timeout=10) == 143
        _assert_stopped(state, env)


@pytest.mark.parametrize("role", ["python", "rust"])
def test_unexpected_child_exit_stops_the_other_process(
    tmp_path: Path, role: str
) -> None:
    """An incomplete backend must exit rather than leave an orphan service."""
    with _launch(tmp_path) as (process, env, state):
        os.kill(int(state[role]), signal.SIGKILL)
        assert process.wait(timeout=10) != 0
        _assert_stopped(state, env)


def test_invalid_reload_mode_fails_before_starting_children(tmp_path: Path) -> None:
    """A mistyped production mode must not silently enable hot reload."""
    env = _environment(tmp_path, production=True)
    env["WEGENT_PYTHON_RELOAD"] = "invalid"
    result = subprocess.run(
        ["bash", str(LAUNCHER)], env=env, capture_output=True, text=True
    )
    assert result.returncode == 2
    assert "WEGENT_PYTHON_RELOAD" in result.stderr
    assert not (tmp_path / "python.json").exists()
