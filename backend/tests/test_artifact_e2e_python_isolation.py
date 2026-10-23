# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise uv against a foreign service venv without touching that environment."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("editable_dependency", [False, True])
def test_artifact_python_command_preserves_mounted_service_environment(
    tmp_path: Path, editable_dependency: bool
) -> None:
    project = tmp_path / "backend"
    project.mkdir()
    dependencies = ""
    if editable_dependency:
        dependency = tmp_path / "shared"
        dependency.mkdir()
        (dependency / "pyproject.toml").write_text(
            '[project]\nname = "artifact-dependency"\nversion = "1.0.0"\n'
            "[build-system]\nrequires = []\n"
            'build-backend = "build_backend"\nbackend-path = ["."]\n',
            encoding="utf-8",
        )
        (dependency / "artifact_dependency.py").write_text("VALUE = 42\n")
        (dependency / "build_backend.py").write_bytes(
            (
                Path(__file__).parent / "fixtures/artifact_editable_build_backend.py"
            ).read_bytes()
        )
        dependencies = (
            'dependencies = ["artifact-dependency"]\n'
            "[tool.uv.sources]\n"
            'artifact-dependency = { path = "../shared", editable = true }\n'
        )
    (project / "pyproject.toml").write_text(
        '[project]\nname = "artifact-isolation-test"\nversion = "0.0.0"\n'
        f'requires-python = ">=3.10"\n{dependencies}'
        "[tool.uv]\npackage = false\n",
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
        "UV_NO_EDITABLE": "0",
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
    watched_python = {
        path: (path.read_bytes(), path.stat().st_mtime_ns)
        for path in tmp_path.rglob("*.py")
        if tmp_path / "cache" not in path.parents
    }

    # These are the same flags asserted at the Node fixture's process boundary.
    completed = subprocess.run(
        [
            "uv",
            "run",
            "--isolated",
            "--frozen",
            "--no-env-file",
            "--python",
            sys.executable,
            "python",
            "-c",
            (
                ("import artifact_dependency; " if editable_dependency else "")
                + "import json, sys; print(json.dumps(sys.prefix))"
            ),
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
    assert {
        path: (path.read_bytes(), path.stat().st_mtime_ns)
        for path in tmp_path.rglob("*.py")
        if tmp_path / "cache" not in path.parents
    } == watched_python
