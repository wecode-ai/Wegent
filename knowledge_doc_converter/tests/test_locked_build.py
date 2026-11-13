"""The converter image must use the checked-in dependency graph."""

import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_image_installs_exported_locked_requirements() -> None:
    dockerfile = (ROOT / "docker/knowledge_doc_converter/Dockerfile").read_text()
    assert "knowledge_doc_converter/uv.lock" in dockerfile
    assert re.search(r"uv export\s+--locked\b", dockerfile)
    assert "-r /tmp/converter-requirements.txt" in dockerfile
    assert "-r pyproject.toml" not in dockerfile


def test_locked_export_resolves_local_packages_in_image_layout(tmp_path: Path) -> None:
    for package in ("shared", "knowledge_engine", "knowledge_doc_converter"):
        target = tmp_path / package
        target.mkdir()
        shutil.copy2(ROOT / package / "pyproject.toml", target)
    converter = tmp_path / "knowledge_doc_converter"
    shutil.copy2(ROOT / "knowledge_doc_converter/uv.lock", converter)
    lock_before = (converter / "uv.lock").read_bytes()
    result = subprocess.run(
        [
            "uv",
            "export",
            "--locked",
            "--offline",
            "--no-dev",
            "--no-emit-project",
            "--format",
            "requirements.txt",
        ],
        cwd=converter,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert (converter / "uv.lock").read_bytes() == lock_before
    assert "-e ../shared" in result.stdout
    assert "-e ../knowledge_engine" in result.stdout
    assert "redis==6.4.0" in result.stdout
    assert not re.search(r"^pytest[=\[]", result.stdout, re.MULTILINE)
