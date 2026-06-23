# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from app.services.skill_service import SkillValidator

pytestmark = pytest.mark.unit

BACKEND_ROOT = Path(__file__).resolve().parents[3]
SKILL_DIR = BACKEND_ROOT / "init_data" / "skills" / "wegent-help"


def _create_skill_zip(skill_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for file_path in skill_dir.rglob("*"):
            if not file_path.is_file():
                continue
            arcname = f"{skill_dir.name}/{file_path.relative_to(skill_dir)}"
            zip_file.write(file_path, arcname)
    return buffer.getvalue()


def test_wegent_help_skill_package_validates() -> None:
    zip_content = _create_skill_zip(SKILL_DIR)

    metadata = SkillValidator.validate_zip(zip_content, "wegent-help.zip")

    assert metadata["displayName"] == "Wegent 帮助"
    assert metadata["preload"] is False
    assert "Wegent Help" in metadata["prompt"]
    assert "wegent-knowledge" in metadata["prompt"]
    assert set(metadata["bindShells"]) == {"Chat", "ClaudeCode"}
