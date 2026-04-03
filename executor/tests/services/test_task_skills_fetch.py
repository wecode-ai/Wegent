# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock

from executor.services.api_client import fetch_task_skills


def test_fetch_task_skills_returns_ref_metadata(monkeypatch):
    response = Mock()
    response.json.return_value = {
        "task_id": 123,
        "team_id": 456,
        "team_namespace": "team-a",
        "skills": ["ghost-skill", "subscription-skill"],
        "preload_skills": ["subscription-skill"],
        "skill_refs": {
            "ghost-skill": {
                "skill_id": 11,
                "namespace": "team-a",
                "is_public": False,
            }
        },
        "preload_skill_refs": {
            "subscription-skill": {
                "skill_id": 22,
                "namespace": "team-a",
                "is_public": False,
            }
        },
    }

    monkeypatch.setattr(
        "executor.services.api_client.ApiClient.get",
        lambda self, path, timeout=30, **kwargs: response,
    )

    result = fetch_task_skills("123", "token")

    assert result.task_id == 123
    assert result.team_id == 456
    assert result.team_namespace == "team-a"
    assert result.skill_refs["ghost-skill"]["skill_id"] == 11
    assert result.preload_skill_refs["subscription-skill"]["skill_id"] == 22
