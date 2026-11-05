"""Background services survive cleanup of the command that launched them."""

import json
import os
import shlex
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SERVICE = """
import http.server
import json
import os
import sys
from pathlib import Path

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'healthy')

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
marker = Path(sys.argv[1])
temporary = marker.with_suffix('.tmp')
temporary.write_text(json.dumps({
    'pid': os.getpid(), 'group': os.getpgrp(), 'session': os.getsid(0),
    'port': server.server_port, 'cwd': os.getcwd(), 'env': os.environ['SERVICE_TEST'],
    'stdin': sys.stdin.read(),
}))
temporary.replace(marker)
server.serve_forever()
"""


def _wait_for_file(path: Path) -> str:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if path.exists() and path.stat().st_size:
            return path.read_text()
        time.sleep(0.02)
    raise AssertionError(f"Service did not write {path.name}")


@pytest.mark.parametrize("parent_cleanup", [False, True])
def test_service_survives_launcher_exit_and_process_group_cleanup(
    tmp_path: Path, parent_cleanup: bool
) -> None:
    source = (ROOT / "start.sh").read_text()
    function = source.split("spawn_background_service() {\n", 1)[1].split("\n}\n", 1)[0]
    marker = tmp_path / "service.json"
    pid_file = tmp_path / "service.pid"
    log_file = tmp_path / "service.log"
    service_command = shlex.join([sys.executable, "-c", SERVICE, str(marker)])
    command = (
        "set -e\nspawn_background_service() {\n"
        + function
        + '\n}\nspawn_background_service "$1" "$2" > "$3"\n'
        + ("exec sleep 300\n" if parent_cleanup else "")
    )
    parent = subprocess.Popen(
        ["bash", "-c", command, "_", service_command, str(log_file), str(pid_file)],
        cwd=tmp_path,
        env={**os.environ, "PYTHON_CMD": sys.executable, "SERVICE_TEST": "inherited"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    service_pid: int | None = None
    try:
        service_pid = int(_wait_for_file(pid_file))
        state = json.loads(_wait_for_file(marker))
        assert state["pid"] == service_pid
        assert state["group"] == state["session"] == service_pid
        assert state["group"] != parent.pid
        assert state["cwd"] == str(tmp_path)
        assert state["env"] == "inherited"
        assert state["stdin"] == ""
        if parent_cleanup:
            os.killpg(parent.pid, signal.SIGTERM)
        parent.communicate(timeout=10)
        assert parent.returncode == (-signal.SIGTERM if parent_cleanup else 0)
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with client.open(
            f"http://127.0.0.1:{state['port']}/health", timeout=5
        ) as response:
            assert response.status == 200
            assert response.read() == b"healthy"
    finally:
        if parent.poll() is None:
            os.killpg(parent.pid, signal.SIGKILL)
            parent.communicate(timeout=10)
        if service_pid is not None:
            try:
                if os.getpgid(service_pid) == service_pid:
                    os.killpg(service_pid, signal.SIGTERM)
                else:
                    os.kill(service_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
