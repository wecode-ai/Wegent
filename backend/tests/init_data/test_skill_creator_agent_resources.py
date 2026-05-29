# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the built-in Skill Creator agent resources."""

import io
import zipfile
from pathlib import Path

import pytest
import yaml

from app.services.skill_service import SkillValidator

pytestmark = pytest.mark.unit

BACKEND_ROOT = Path(__file__).resolve().parents[2]
INIT_DATA_DIR = BACKEND_ROOT / "init_data"
PUBLIC_RESOURCES_PATH = INIT_DATA_DIR / "02-public-resources.yaml"
SKILL_CREATOR_DIR = INIT_DATA_DIR / "skills" / "skill-creator"


def _load_public_resources() -> list[dict]:
    with PUBLIC_RESOURCES_PATH.open("r", encoding="utf-8") as handle:
        return [
            doc
            for doc in yaml.safe_load_all(handle)
            if isinstance(doc, dict) and doc.get("kind") and doc.get("metadata")
        ]


def _find_resource(resources: list[dict], kind: str, name: str) -> dict:
    for resource in resources:
        if resource.get("kind") == kind and resource["metadata"].get("name") == name:
            return resource
    raise AssertionError(f"{kind}/{name} not found in 02-public-resources.yaml")


def _create_skill_zip(skill_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for file_path in skill_dir.rglob("*"):
            if not file_path.is_file():
                continue
            if "__pycache__" in file_path.parts or file_path.suffix == ".pyc":
                continue
            arcname = f"{skill_dir.name}/{file_path.relative_to(skill_dir)}"
            zip_file.write(file_path, arcname)
    return buffer.getvalue()


def test_skill_creator_agent_resources_exist() -> None:
    resources = _load_public_resources()

    ghost = _find_resource(resources, "Ghost", "skill-creator-ghost")
    bot = _find_resource(resources, "Bot", "skill-creator-bot")
    team = _find_resource(resources, "Team", "skill-creator-team")

    ghost_spec = ghost["spec"]
    assert set(ghost_spec["skills"]) >= {
        "skill-creator",
        "interactive-form-question",
        "ui-links",
    }
    assert "interactive_form_question" in ghost_spec["systemPrompt"]
    assert "list_publish_targets.sh" in ghost_spec["systemPrompt"]
    assert "publish_skill.sh" in ghost_spec["systemPrompt"]

    bot_spec = bot["spec"]
    assert bot_spec["ghostRef"] == {
        "name": "skill-creator-ghost",
        "namespace": "default",
    }
    assert bot_spec["shellRef"] == {"name": "ClaudeCode", "namespace": "default"}

    team_spec = team["spec"]
    assert team["metadata"]["displayName"] == "Skill Creator"
    assert team_spec["collaborationModel"] == "solo"
    assert team_spec["bind_mode"] == ["chat", "task"]
    assert team_spec["workflow"]["mode"] == "solo"
    assert team_spec["members"][0]["botRef"] == {
        "name": "skill-creator-bot",
        "namespace": "default",
    }


def test_skill_creator_skill_documents_card_publish_flow() -> None:
    content = (SKILL_CREATOR_DIR / "SKILL.md").read_text(encoding="utf-8")

    assert "interactive_form_question" in content
    assert "list_publish_targets.sh" in content
    assert "publish_skill.sh" in content
    assert "--overwrite" in content
    assert "custom namespace" in content.lower()


def test_skill_creator_package_still_validates_after_script_changes() -> None:
    zip_content = _create_skill_zip(SKILL_CREATOR_DIR)

    metadata = SkillValidator.validate_zip(zip_content, "skill-creator.zip")

    assert metadata["description"]
    assert metadata["file_size"] == len(zip_content)
    assert len(metadata["file_hash"]) == 64
