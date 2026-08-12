# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock

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
