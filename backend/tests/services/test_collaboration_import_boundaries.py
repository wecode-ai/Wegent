"""Permission and storage reads do not initialize the execution subsystem."""

import subprocess
from pathlib import Path


def test_collaboration_metadata_imports_do_not_load_execution_dispatch() -> None:
    script = """
import importlib
import sys

for module in (
    "app.services.cloud_projects.access",
    "app.services.workspaces.storage",
    "app.services.collaboration_revocation",
):
    importlib.import_module(module)

assert "app.services.execution.dispatcher" not in sys.modules
assert "app.api.ws.chat_namespace" not in sys.modules
"""
    subprocess.run(
        ["uv", "run", "--offline", "--no-sync", "python", "-c", script],
        cwd=Path(__file__).resolve().parents[2],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
