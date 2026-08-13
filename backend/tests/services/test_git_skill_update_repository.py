# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.services.adapters.skill_kinds import skill_kinds_service
from app.services.git_skill.service import GitSkillService


def test_update_skill_from_repository_updates_the_exact_skill(monkeypatch):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=42,
        name="current-skill",
        user_id=7,
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.get_auth_for_repo",
        lambda repo_url, user_id, db: ("gitlab", "team", "skills", "auth"),
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.download_repo_zip",
        lambda provider, owner, repo, auth_info: b"repository",
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.extract_zip_safely",
        lambda content, target: None,
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.find_repo_root",
        lambda target: "/tmp/repository",
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.validate_skill_directory",
        lambda skill_dir, skill_path: None,
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.package_skill_directory",
        lambda skill_dir, skill_name: b"skill-archive",
    )
    update_skill = MagicMock(
        return_value=SimpleNamespace(
            metadata=SimpleNamespace(
                labels={"id": "42"},
                name="current-skill",
            ),
            spec=SimpleNamespace(version="2.0.0"),
        )
    )
    monkeypatch.setattr(skill_kinds_service, "update_skill", update_skill)

    result = GitSkillService().update_skill_from_repository(
        skill_id=42,
        skill_owner_user_id=7,
        auth_user_id=9,
        repo_url="https://git.example.com/team/skills",
        skill_path="skills/current-skill",
        db=db,
    )

    assert result["id"] == 42
    assert result["name"] == "current-skill"
    assert result["version"] == "2.0.0"
    update_skill.assert_called_once()
    assert update_skill.call_args.kwargs["skill_id"] == 42
    assert update_skill.call_args.kwargs["user_id"] == 7
    assert (
        update_skill.call_args.kwargs["source"]["skill_path"] == "skills/current-skill"
    )


def test_update_skill_from_repository_rejects_missing_skill(monkeypatch):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    update_skill = MagicMock()
    monkeypatch.setattr(skill_kinds_service, "update_skill", update_skill)

    with pytest.raises(HTTPException) as exc_info:
        GitSkillService().update_skill_from_repository(
            skill_id=42,
            skill_owner_user_id=7,
            auth_user_id=9,
            repo_url="https://git.example.com/team/skills",
            skill_path="skills/current-skill",
            db=db,
        )

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Skill not found"
    update_skill.assert_not_called()


def test_update_skill_from_repository_rejects_skill_name_mismatch(monkeypatch):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=42,
        name="current-skill",
        user_id=7,
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.get_auth_for_repo",
        lambda repo_url, user_id, db: ("gitlab", "team", "skills", "auth"),
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.download_repo_zip",
        lambda provider, owner, repo, auth_info: b"repository",
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.extract_zip_safely",
        lambda content, target: None,
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.find_repo_root",
        lambda target: "/tmp/repository",
    )
    validate_skill_directory = MagicMock()
    update_skill = MagicMock()
    monkeypatch.setattr(
        "app.services.git_skill.service.validate_skill_directory",
        validate_skill_directory,
    )
    monkeypatch.setattr(skill_kinds_service, "update_skill", update_skill)

    with pytest.raises(HTTPException) as exc_info:
        GitSkillService().update_skill_from_repository(
            skill_id=42,
            skill_owner_user_id=7,
            auth_user_id=9,
            repo_url="https://git.example.com/team/skills",
            skill_path="skills/different-skill",
            db=db,
        )

    assert exc_info.value.status_code == 400
    assert (
        exc_info.value.detail
        == "Repository skill name does not match the current skill"
    )
    validate_skill_directory.assert_not_called()
    update_skill.assert_not_called()


@pytest.mark.parametrize(
    ("skill_path", "expected_detail"),
    [
        ("/tmp/current-skill", "Skill path must be relative to the repository"),
        ("../current-skill", "Skill path must be inside the repository"),
    ],
)
def test_update_skill_from_repository_rejects_path_escape(
    monkeypatch, skill_path, expected_detail
):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=42,
        name="current-skill",
        user_id=7,
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.get_auth_for_repo",
        lambda repo_url, user_id, db: ("gitlab", "team", "skills", "auth"),
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.download_repo_zip",
        lambda provider, owner, repo, auth_info: b"repository",
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.extract_zip_safely",
        lambda content, target: None,
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.find_repo_root",
        lambda target: "/tmp/repository",
    )
    validate_skill_directory = MagicMock()
    package_skill_directory = MagicMock()
    update_skill = MagicMock()
    monkeypatch.setattr(
        "app.services.git_skill.service.validate_skill_directory",
        validate_skill_directory,
    )
    monkeypatch.setattr(
        "app.services.git_skill.service.package_skill_directory",
        package_skill_directory,
    )
    monkeypatch.setattr(skill_kinds_service, "update_skill", update_skill)

    with pytest.raises(HTTPException) as exc_info:
        GitSkillService().update_skill_from_repository(
            skill_id=42,
            skill_owner_user_id=7,
            auth_user_id=9,
            repo_url="https://git.example.com/team/skills",
            skill_path=skill_path,
            db=db,
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == expected_detail
    validate_skill_directory.assert_not_called()
    package_skill_directory.assert_not_called()
    update_skill.assert_not_called()
