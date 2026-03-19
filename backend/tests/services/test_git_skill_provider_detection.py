# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Git skill provider detection from repository URLs and hosts."""

import httpx
import pytest
from fastapi import HTTPException

from app.services.git_skill.models import RepoAuthInfo
from app.services.git_skill.providers import get_provider_by_host
from app.services.git_skill.providers.gitea import GiteaProvider
from app.services.git_skill.providers.gitlab import GitLabProvider
from app.services.git_skill.utils import (
    download_repo_zip,
    get_user_git_info,
    parse_repo_url,
)
from shared.utils.crypto import encrypt_git_token


def test_get_provider_by_host_detects_custom_gitlab_domain() -> None:
    provider = get_provider_by_host("gitlab.weibo.cn", "https://gitlab.weibo.cn")

    assert isinstance(provider, GitLabProvider)


def test_parse_repo_url_detects_custom_gitlab_domain() -> None:
    parsed = parse_repo_url("https://gitlab.weibo.cn/MPS/skills")

    assert isinstance(parsed.provider, GitLabProvider)
    assert parsed.owner == "MPS"
    assert parsed.repo == "skills"


def test_get_provider_by_host_falls_back_to_gitea_for_unknown_host() -> None:
    provider = get_provider_by_host(
        "git.internal.example", "https://git.internal.example"
    )

    assert isinstance(provider, GiteaProvider)


def test_get_provider_by_host_does_not_match_gitlab_substring_in_label() -> None:
    provider = get_provider_by_host(
        "mygitlabproxy.example.com",
        "https://mygitlabproxy.example.com",
    )

    assert isinstance(provider, GiteaProvider)


def test_gitlab_provider_sends_bearer_and_private_token_headers() -> None:
    provider = GitLabProvider(
        host="gitlab.weibo.cn",
        base_url="https://gitlab.weibo.cn",
    )
    auth = RepoAuthInfo(password="my-token", auth_source="platform_integration")

    api_headers = provider.get_api_headers(auth)
    zip_headers = provider.get_zip_headers(auth)

    assert api_headers["Authorization"] == "Bearer my-token"
    assert api_headers["PRIVATE-TOKEN"] == "my-token"
    assert zip_headers["Authorization"] == "Bearer my-token"
    assert zip_headers["PRIVATE-TOKEN"] == "my-token"


def test_gitlab_zip_download_url_uses_api_archive_endpoint() -> None:
    provider = GitLabProvider(
        host="gitlab.weibo.cn",
        base_url="https://gitlab.weibo.cn",
    )

    url = provider.get_zip_download_url("MPS", "skills", "main")

    assert (
        url
        == "https://gitlab.weibo.cn/api/v4/projects/MPS%2Fskills/repository/archive.zip?sha=main"
    )


def test_download_repo_zip_rejects_non_zip_payload(monkeypatch) -> None:
    provider = GitLabProvider(
        host="gitlab.weibo.cn",
        base_url="https://gitlab.weibo.cn",
    )
    auth = RepoAuthInfo(password="token", auth_source="platform_integration")

    def mock_get_default_branch(owner, repo, auth_info):  # noqa: ANN001
        return "main"

    def mock_get(self, url, headers=None):  # noqa: ANN001
        request = httpx.Request("GET", url)
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/html; charset=utf-8"},
            content=b"<html>login</html>",
        )

    monkeypatch.setattr(provider, "get_default_branch", mock_get_default_branch)
    monkeypatch.setattr(httpx.Client, "get", mock_get)

    with pytest.raises(HTTPException, match="not a valid ZIP archive"):
        download_repo_zip(provider, "MPS", "skills", auth)


def test_get_user_git_info_matches_domain_with_scheme(test_db, test_user) -> None:
    test_user.git_info = [
        {
            "type": "gitlab",
            "git_domain": "https://gitlab.weibo.cn",
            "git_token": encrypt_git_token("token-by-domain"),
        }
    ]
    test_db.add(test_user)
    test_db.commit()

    git_info = get_user_git_info(test_user.id, "gitlab.weibo.cn", test_db)

    assert git_info is not None
    assert git_info["type"] == "gitlab"
    assert git_info["token"] == "token-by-domain"


def test_get_user_git_info_falls_back_to_single_type_entry(test_db, test_user) -> None:
    test_user.git_info = [
        {
            "type": "gitlab",
            "git_domain": "gitlab-alt.weibo.cn",
            "git_token": encrypt_git_token("token-by-type"),
        }
    ]
    test_db.add(test_user)
    test_db.commit()

    git_info = get_user_git_info(
        test_user.id,
        "gitlab.weibo.cn",
        test_db,
        git_type="gitlab",
    )

    assert git_info is not None
    assert git_info["type"] == "gitlab"
    assert git_info["token"] == "token-by-type"
