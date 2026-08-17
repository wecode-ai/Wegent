# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for versioned built-in Skill initialization."""

from pathlib import Path
from types import SimpleNamespace
from typing import Any

from app.core.yaml_init import apply_skills_from_directory


def _write_skill(tmp_path: Path, version: str) -> None:
    skill_dir = tmp_path / "sandbox"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                'description: "Sandbox"',
                f'version: "{version}"',
                "---",
                "",
                "# Sandbox",
            ]
        ),
        encoding="utf-8",
    )
    (skill_dir / "provider.py").write_text("VALUE = 1\n", encoding="utf-8")


def _existing_skill(version: str) -> SimpleNamespace:
    return SimpleNamespace(
        metadata=SimpleNamespace(labels={"id": "42"}),
        spec=SimpleNamespace(version=version),
    )


def test_apply_skills_updates_existing_skill_when_version_increases(
    tmp_path: Path, mocker: Any
) -> None:
    _write_skill(tmp_path, "2.1.1")
    service = mocker.patch("app.services.adapters.skill_kinds.skill_kinds_service")
    service.get_skill_by_name.return_value = _existing_skill("2.1.0")

    results = apply_skills_from_directory(mocker.Mock(), 1, tmp_path)

    assert results == [
        {
            "kind": "Skill",
            "name": "sandbox",
            "namespace": "default",
            "operation": "updated",
            "success": True,
        }
    ]
    service.update_skill.assert_called_once()
    assert service.update_skill.call_args.kwargs["skill_id"] == 42
    assert service.update_skill.call_args.kwargs["user_id"] == 0
    service.create_skill.assert_not_called()


def test_apply_skills_skips_existing_skill_at_same_version(
    tmp_path: Path, mocker: Any
) -> None:
    _write_skill(tmp_path, "2.1.1")
    service = mocker.patch("app.services.adapters.skill_kinds.skill_kinds_service")
    service.get_skill_by_name.return_value = _existing_skill("2.1.1")

    results = apply_skills_from_directory(mocker.Mock(), 1, tmp_path)

    assert results[0]["operation"] == "skipped"
    assert results[0]["reason"] == "already_exists"
    service.update_skill.assert_not_called()
    service.create_skill.assert_not_called()


def test_apply_skills_skips_existing_skill_with_invalid_version(
    tmp_path: Path, mocker: Any
) -> None:
    _write_skill(tmp_path, "next")
    service = mocker.patch("app.services.adapters.skill_kinds.skill_kinds_service")
    service.get_skill_by_name.return_value = _existing_skill("current")

    results = apply_skills_from_directory(mocker.Mock(), 1, tmp_path)

    assert results[0]["operation"] == "skipped"
    service.update_skill.assert_not_called()
