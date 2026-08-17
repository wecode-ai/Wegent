# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from app.services.adapters.public_skill import PublicSkillAdapter


@pytest.mark.parametrize(
    ("repo_url", "expected_repo_url"),
    [
        (
            "https://user:password@git.example.com/team/skills.git",
            "https://git.example.com/team/skills.git",
        ),
        (
            "https://token@git.example.com/team/skills.git",
            "https://git.example.com/team/skills.git",
        ),
        (
            "git.example.com/team/skills.git",
            "git.example.com/team/skills.git",
        ),
    ],
)
def test_public_skill_adapter_sanitizes_git_credentials(repo_url, expected_repo_url):
    source = {
        "type": "git",
        "repo_url": repo_url,
        "skill_path": "skills/example",
    }
    kind = SimpleNamespace(
        id=1,
        name="example",
        namespace="default",
        json={"spec": {"source": source}},
        is_active=True,
        user_id=0,
        created_at=None,
        updated_at=None,
    )

    result = PublicSkillAdapter.to_skill_dict(kind)

    assert result["source"]["repo_url"] == expected_repo_url
    assert result["source"]["skill_path"] == "skills/example"
    assert source["repo_url"] == repo_url
