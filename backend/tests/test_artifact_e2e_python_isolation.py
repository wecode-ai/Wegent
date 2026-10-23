# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise uv against a foreign service venv without touching that environment."""

import json
import os
import subprocess
import sys
from pathlib import Path


def test_artifact_python_command_preserves_mounted_service_environment(
    tmp_path: Path,
) -> None:
    project = tmp_path / "backend"
    project.mkdir()
    (project / "pyproject.toml").write_text(
        '[project]\nname = "artifact-isolation-test"\nversion = "0.0.0"\n'
        'requires-python = ">=3.10"\n[tool.uv]\npackage = false\n',
        encoding="utf-8",
    )
    service_venv = project / ".venv"
    service_venv.mkdir()
    config = service_venv / "pyvenv.cfg"
    config.write_text("home = /host-only-python\nversion = 3.10.0\n", encoding="utf-8")
    canary = service_venv / "must-not-change.py"
    canary.write_text("SERVICE_ENVIRONMENT_CANARY\n", encoding="utf-8")
    environment = {
        **os.environ,
        "UV_PROJECT_ENVIRONMENT": str(service_venv),
        "UV_NO_SYNC": "0",
        "UV_CACHE_DIR": str(tmp_path / "cache"),
        "UV_OFFLINE": "1",
        "UV_PYTHON_DOWNLOADS": "never",
    }
    subprocess.run(
        ["uv", "lock", "--python", sys.executable],
        cwd=project,
        env=environment,
        check=True,
        capture_output=True,
        timeout=30,
    )
    lockfile = project / "uv.lock"
    before = {
        path: (path.read_bytes(), path.stat().st_mtime_ns)
        for path in (config, canary, lockfile)
    }

    # These are the same flags asserted at the Node fixture's process boundary.
    completed = subprocess.run(
        [
            "uv",
            "run",
            "--isolated",
            "--frozen",
            "--no-editable",
            "--no-env-file",
            "--python",
            sys.executable,
            "python",
            "-c",
            "import json, sys; print(json.dumps(sys.prefix))",
        ],
        cwd=project,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert Path(json.loads(completed.stdout)).resolve() != service_venv.resolve()
    assert {
        path: (path.read_bytes(), path.stat().st_mtime_ns) for path in before
    } == before
