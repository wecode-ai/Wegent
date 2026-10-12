"""Exercise root launcher environment preparation and Uvicorn CLI parsing."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("existing_env", [False, True])
def test_root_launcher_prepares_runtime_environment(
    tmp_path: Path, existing_env: bool
) -> None:
    launcher = (REPOSITORY_ROOT / "start.sh").read_text()
    env_function = launcher.split("check_python_env() {", 1)[1].split("\n}\n", 1)[0]
    preparation = launcher.split("    # Check Python env\n", 1)[1].split(
        "    # Patch backend connection URLs", 1
    )[0]
    runtime_launch = launcher.split("    # 4. Start Knowledge Runtime\n", 1)[1].split(
        "    # 5. Start Frontend", 1
    )[0]
    runtime = tmp_path / "knowledge_runtime"
    runtime.mkdir()
    (tmp_path / "shared").mkdir()
    (tmp_path / "knowledge_engine").mkdir()
    template = REPOSITORY_ROOT / "knowledge_runtime/.env.example"
    (runtime / ".env.example").write_text(template.read_text())
    expected_env = template.read_text()
    if existing_env:
        expected_env = "KNOWLEDGE_RUNTIME_CONTENT_FETCH_TIMEOUT=73\n"
        (runtime / ".env").write_text(expected_env)
    (runtime / ".venv/bin").mkdir(parents=True)
    (runtime / ".venv/bin/activate").touch()

    # Parse the real Uvicorn CLI and load dotenv, without starting a server.
    probe = tmp_path / "probe.py"
    probe.write_text(
        """
import sys
from unittest.mock import patch
import uvicorn
from click.testing import CliRunner
from knowledge_runtime.config import Settings

def check_runtime(app, **kwargs):
    uvicorn.Config(app, env_file=kwargs['env_file'])
    assert Settings().internal_service_token == 'synthetic-shared-token'

with patch('uvicorn.main.run', side_effect=check_runtime):
    result = CliRunner().invoke(uvicorn.main, sys.argv[1:])
print(result.output, end='')
if result.exception:
    print(str(result.exception))
sys.exit(result.exit_code)
"""
    )
    script = (
        "set -e\n"
        "check_python_env() {" + env_function + "\n}\n"
        'start_service() { (cd "$SCRIPT_DIR/$2" && eval "$3"); }\n'
        'uvicorn() { "$PROBE_PYTHON" "$PROBE_SCRIPT" "$@"; }\n'
        "start_backend=false\nstart_chat_shell=false\nstart_knowledge_runtime=true\n"
        + preparation
        + runtime_launch
    )
    environment = {
        key: value
        for key, value in os.environ.items()
        if key != "INTERNAL_SERVICE_TOKEN" and not key.startswith("KNOWLEDGE_RUNTIME_")
    }
    environment.update(
        SCRIPT_DIR=str(tmp_path),
        PROBE_PYTHON=sys.executable,
        PROBE_SCRIPT=str(probe),
        INTERNAL_SERVICE_TOKEN="synthetic-shared-token",
        BACKEND_PORT="8000",
        KNOWLEDGE_RUNTIME_PORT="8200",
        KNOWLEDGE_RUNTIME_URL="http://localhost:8200",
        RELOAD_EXCLUDE="",
    )
    result = subprocess.run(
        ["bash", "-c", script], env=environment, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (runtime / ".env").read_text() == expected_env
