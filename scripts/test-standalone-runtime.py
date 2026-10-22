"""Exercise standalone startup with command substitutes, without Docker."""

import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# macOS ships Bash 3.2; CI and the image exercise the native Bash 5 wait -n.
LEGACY_WAIT = """
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
    wait() {
        if [ "${1:-}" != "-n" ]; then
            builtin wait "$@"
            return $?
        fi
        shift
        while true; do
            for child_pid in "$@"; do
                if ! kill -0 "$child_pid" 2>/dev/null; then
                    builtin wait "$child_pid"
                    return $?
                fi
            done
            sleep 0.01
        done
    }
fi
"""
STUB = r"""
import json, os, signal, sys, time
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
log = Path(os.environ["TEST_EVENTS"])
def record(event):
    with log.open("a") as f:
        f.write(json.dumps(event) + "\n")
if name in ("python", "python3"):
    if args == ["-m", "app.scripts.ensure_standalone_executor_token"]:
        print("test-executor-token")
        sys.exit(0)
    os.execv(os.environ["TEST_PYTHON"], [os.environ["TEST_PYTHON"], *args])
if name == "curl":
    if args[-1].endswith("/internal/rag/health"):
        events = log.read_text() if log.exists() else ""
        ready = '"service": "runtime"' in events and os.environ["TEST_MODE"] != "startup-failure"
        if ready:
            record({"event": "runtime-ready"})
        sys.exit(0 if ready else 1)
    sys.exit(0)
if name == "sleep":
    time.sleep(0.01)
    sys.exit(0)
if name == "redis-cli" or name == "mysqladmin":
    if name == "redis-cli" and args[:1] == ["shutdown"]:
        for line in log.read_text().splitlines():
            event = json.loads(line)
            if event.get("service") == "redis-server" and event["event"] == "start":
                os.kill(event["pid"], signal.SIGTERM)
    sys.exit(0)
if name == "alembic":
    record({"event": "migration"})
    sys.exit(0)
if name in ("mysql", "chown") or (name == "nginx" and args == ["-t"]):
    sys.exit(0)
if name == "mysqld" and "--initialize-insecure" in args:
    sys.exit(0)
service = name
if name == "node" and os.environ["TEST_MODE"] == "after-ready-exit":
    time.sleep(0.3)
if name == "uvicorn":
    service = "runtime" if args[0] == "knowledge_runtime.main:app" else "python-backend"
def stop(*_):
    record({"event": "stop", "service": service})
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
record({"event": "start", "service": service, "pid": os.getpid(), "args": args,
        "database": os.environ.get("DATABASE_URL"), "token": os.environ.get("INTERNAL_SERVICE_TOKEN"),
        "runtime_url": os.environ.get("KNOWLEDGE_RUNTIME_URL"), "backend_url": os.environ.get("BACKEND_INTERNAL_URL")})
if service == "runtime" and os.environ["TEST_MODE"] == "startup-failure":
    sys.exit(23)
while True:
    if service == "runtime" and os.environ["TEST_MODE"] == "after-ready-exit" and '"service": "python-backend"' in log.read_text():
        sys.exit(23)
    if service == "runtime" and os.environ["TEST_MODE"] in ("runtime-exit", "runtime-clean-exit") and '"service": "nginx"' in log.read_text():
        time.sleep(0.2)
        sys.exit(23 if os.environ["TEST_MODE"] == "runtime-exit" else 0)
    time.sleep(0.01)
"""


def check_image_contract() -> None:
    """Check the image recipe without performing a Docker build."""
    recipe = (ROOT / "docker/standalone/Dockerfile").read_text().replace("\\\n", " ")
    instructions = [
        shlex.split(line)
        for line in recipe.splitlines()
        if line and not line.startswith("#")
    ]
    assert any(parts[:2] == ["COPY", "knowledge_runtime"] for parts in instructions)
    assert any(
        parts[0] == "RUN" and "/app/knowledge_engine[retrieval]" in parts
        for parts in instructions
    )
    assert any(
        parts[0] == "RUN"
        and "/app/knowledge_runtime" in parts
        and "pyproject.toml" in parts
        for parts in instructions
    )
    assert any(
        parts[0] == "ENV"
        and any(
            part.startswith("PYTHONPATH=") and "/app/knowledge_runtime" in part
            for part in parts
        )
        for parts in instructions
    )
    assert any(
        parts[0] == "HEALTHCHECK"
        and "http://127.0.0.1:8200/internal/rag/health" in parts
        for parts in instructions
    )
    assert not any(parts[0] == "EXPOSE" and "8200" in parts for parts in instructions)


def check_startup(mode: str) -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for folder in (
            "backend",
            "backend-rs",
            "frontend",
            "knowledge_runtime",
            "wework/dist",
        ):
            (root / "app" / folder).mkdir(parents=True)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        for command in (
            "python",
            "python3",
            "curl",
            "sleep",
            "redis-cli",
            "mysqladmin",
            "alembic",
            "mysql",
            "chown",
            "uvicorn",
            "redis-server",
            "mysqld",
            "nginx",
            "node",
        ):
            path = bin_dir / command
            path.write_text(f"#!{sys.executable}\n" + STUB)
            path.chmod(0o755)
        backend = root / "app/wegent-backend-rs"
        backend.write_text(f"#!{sys.executable}\n" + STUB)
        backend.chmod(0o755)
        script = (ROOT / "docker/standalone/start.sh").read_text()
        for original, replacement in (
            ("/app", str(root / "app")),
            ("/workspace", str(root / "workspace")),
            ("/run/mysqld", str(root / "mysql-run")),
            ("/tmp/redis.conf", str(root / "redis.conf")),
        ):
            script = script.replace(original, replacement)
        startup = root / "start.sh"
        startup.write_text(LEGACY_WAIT + script)
        events_path = root / "events.jsonl"
        env = dict(
            os.environ,
            PATH=f"{bin_dir}:{os.environ['PATH']}",
            TEST_EVENTS=str(events_path),
            TEST_MODE=mode,
            TEST_PYTHON=sys.executable,
            INTERNAL_SERVICE_TOKEN="test-internal-token",
            STANDALONE_EXECUTOR_ENABLED="false",
            MYSQL_DATA_DIR=str(root / "app/data/mysql"),
            CODEX_HOME=str(root / "app/data/codex"),
            BACKEND_PORT="8000",
            FRONTEND_PORT="3002",
        )
        output_path = root / "output.log"
        with output_path.open("w") as output:
            process = subprocess.Popen(
                ["bash", str(startup)],
                env=env,
                stdout=output,
                stderr=output,
                start_new_session=True,
            )
            try:
                deadline = time.monotonic() + 10
                while process.poll() is None and time.monotonic() < deadline:
                    if (
                        mode == "shutdown"
                        and "All services started!" in output_path.read_text()
                    ):
                        process.send_signal(signal.SIGTERM)
                        break
                    time.sleep(0.02)
                process.wait(timeout=5)
                events = [
                    json.loads(line) for line in events_path.read_text().splitlines()
                ]
                starts = [event for event in events if event["event"] == "start"]
                runtime = next(
                    (event for event in starts if event["service"] == "runtime"), None
                )
                assert runtime, "Standalone must start Knowledge Runtime"
                assert events.index({"event": "migration"}) < events.index(runtime)
                assert runtime["database"].endswith("/task_manager")
                assert runtime["token"] == "test-internal-token"
                assert runtime["runtime_url"] == "http://127.0.0.1:8200"
                assert runtime["backend_url"] == "http://127.0.0.1:8000"
                assert runtime["args"][-4:] == ["--host", "127.0.0.1", "--port", "8200"]
                if mode in ("startup-failure", "after-ready-exit"):
                    assert process.returncode != 0
                    if mode == "startup-failure":
                        assert not any(
                            event["service"] == "python-backend" for event in starts
                        )
                    assert "All services started!" not in output_path.read_text()
                else:
                    backend_index = next(
                        index
                        for index, event in enumerate(events)
                        if event.get("service") == "python-backend"
                    )
                    assert events.index({"event": "runtime-ready"}) < backend_index
                    expected_code = {
                        "runtime-exit": 23,
                        "runtime-clean-exit": 1,
                        "shutdown": 0,
                    }[mode]
                    assert process.returncode == expected_code
                stopped = {
                    event["service"] for event in events if event["event"] == "stop"
                }
                assert {event["service"] for event in starts} - {"runtime"} <= stopped
                if mode == "shutdown":
                    assert "runtime" in stopped
            except Exception:
                print(output_path.read_text())
                raise
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    check_image_contract()
    print("Standalone Runtime image contract: passed")
    for scenario in (
        "after-ready-exit",
        "shutdown",
        "startup-failure",
        "runtime-exit",
        "runtime-clean-exit",
    ):
        check_startup(scenario)
        print(f"Standalone Runtime {scenario}: passed")
