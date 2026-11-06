# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import logging
import zipfile

import httpx
import pytest
from fastapi import HTTPException

from app.services.git_skill.models import RepoAuthInfo
from app.services.git_skill.providers.github import GitHubProvider
from app.services.git_skill.utils import (
    download_repo_zip,
    extract_zip_safely,
    scan_skills_in_directory,
)


def test_github_request_logging_never_exposes_token_prefix(caplog):
    provider = GitHubProvider()
    token = "synthetic-secret-github-token"
    auth = RepoAuthInfo(password=token, auth_source="platform_integration")

    with caplog.at_level(logging.INFO):
        provider._log_api_request(provider.get_api_url("owner", "skills"), auth, {})

    assert "auth_source=platform_integration" in caplog.text
    assert token not in caplog.text
    assert token[:8] not in caplog.text
    assert "token_preview" not in caplog.text


@pytest.mark.parametrize("token", [None, "test-github-token"])
def test_github_archive_uses_api_and_follows_download_redirect(
    monkeypatch, tmp_path, token
):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as contents:
        contents.writestr(
            "owner-skills-abc123/demo-skill/SKILL.md",
            "---\ndescription: Archive fixture\n---\n# Demo skill\n",
        )
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.host == "codeload.github.com":
            assert "authorization" not in request.headers
            return httpx.Response(200, content=archive.getvalue())
        if request.url.path.endswith("/zipball/feature/archive"):
            assert request.headers.get("authorization") == (
                f"token {token}" if token else None
            )
            return httpx.Response(
                302,
                headers={
                    "location": "https://codeload.github.com/owner/skills/zip/abc123"
                },
            )
        assert str(request.url) == "https://api.github.com/repos/owner/skills"
        return httpx.Response(200, json={"default_branch": "feature/archive"})

    client = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: client(transport=httpx.MockTransport(handle), **kwargs),
    )
    auth = RepoAuthInfo(password=token) if token else None

    content = download_repo_zip(GitHubProvider(), "owner", "skills", auth)
    extract_zip_safely(content, str(tmp_path))
    skills = scan_skills_in_directory(str(tmp_path))

    assert requests == [
        "https://api.github.com/repos/owner/skills",
        "https://api.github.com/repos/owner/skills/zipball/feature%2Farchive",
        "https://codeload.github.com/owner/skills/zip/abc123",
    ]
    assert [(skill.name, skill.path) for skill in skills] == [
        ("demo-skill", "demo-skill")
    ]


def test_github_archive_preserves_upstream_failure(monkeypatch):
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.path.endswith("/zipball/main"):
            return httpx.Response(502, text="archive unavailable")
        return httpx.Response(200, json={"default_branch": "main"})

    client = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: client(transport=httpx.MockTransport(handle), **kwargs),
    )

    with pytest.raises(HTTPException) as error:
        download_repo_zip(GitHubProvider(), "owner", "skills")

    assert error.value.status_code == 502
    assert "archive unavailable" in error.value.detail
    assert len(requests) == 2
