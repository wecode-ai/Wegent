# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill download priority and fallback behavior."""

from unittest.mock import Mock

from executor.services.api_client import SkillDownloader


def test_download_single_skill_uses_id_path_when_skill_ref_contains_skill_id():
    downloader = SkillDownloader(auth_token="token", team_namespace="default")
    downloader.client.get = Mock(return_value=Mock(content=b"zip-bytes"))
    downloader._extract_skill_zip = Mock(return_value=True)

    result = downloader._download_single_skill(
        "analysis-skill",
        {"skill_id": 123, "namespace": "team-a", "is_public": False},
    )

    assert result is True
    assert downloader.client.get.call_count == 1
    download_path = downloader.client.get.call_args.args[0]
    assert download_path.startswith("/api/v1/kinds/skills/123/download")
    assert "namespace=team-a" in download_path


def test_download_single_skill_falls_back_to_name_query_without_skill_id():
    query_response = Mock()
    query_response.json.return_value = {
        "items": [
            {
                "metadata": {
                    "labels": {"id": 456},
                    "namespace": "default",
                }
            }
        ]
    }
    download_response = Mock(content=b"zip-bytes")

    downloader = SkillDownloader(auth_token="token", team_namespace="default")
    downloader.client.get = Mock(side_effect=[query_response, download_response])
    downloader._extract_skill_zip = Mock(return_value=True)

    result = downloader._download_single_skill("fallback-skill", None)

    assert result is True
    first_call_path = downloader.client.get.call_args_list[0].args[0]
    second_call_path = downloader.client.get.call_args_list[1].args[0]
    assert first_call_path.startswith("/api/v1/kinds/skills?name=fallback-skill")
    assert second_call_path.startswith("/api/v1/kinds/skills/456/download")
