# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the two repository reads a code wiki run depends on.

Each platform words its compare API differently, and each has a way of telling you
less than you asked for: GitHub caps the file list, GitLab gives up on a large diff,
and an older self-hosted Gitea has no compare endpoint at all. All three have to
surface as ``None`` — the caller reads that as "the extent of the change is unknown"
and rebuilds — because an incomplete diff mistaken for a complete one picks an
incremental run for a change that reshaped the repository.
"""

from unittest.mock import Mock, patch

from app.repository.gitea_provider import GiteaProvider
from app.repository.github_provider import GITHUB_COMPARE_FILE_LIMIT, GitHubProvider
from app.repository.gitlab_provider import GitLabProvider

DOMAIN_ARGS = dict(token="t0ken", repo_name="wecode-ai/Wegent")


def _response(payload: dict, status_code: int = 200) -> Mock:
    response = Mock()
    response.status_code = status_code
    response.json.return_value = payload
    response.raise_for_status.return_value = None
    return response


# --- GitHub -----------------------------------------------------------------


def test_github_reads_the_default_branch_and_its_commit():
    provider = GitHubProvider()
    responses = [
        _response({"default_branch": "develop"}),
        _response({"commit": {"sha": "abc123"}}),
    ]

    with patch("app.repository.github_provider.requests.get", side_effect=responses):
        result = provider.get_default_branch_head(
            git_domain="github.com", **DOMAIN_ARGS
        )

    assert result == {"branch": "develop", "commit": "abc123"}


def test_github_maps_compare_statuses_to_name_status_letters():
    """The run-mode rules are written against git's letters, not GitHub's words."""
    provider = GitHubProvider()
    payload = {
        "files": [
            {"filename": "a.py", "status": "added"},
            {"filename": "b.py", "status": "modified"},
            {"filename": "c.py", "status": "removed"},
            {"filename": "d.py", "status": "renamed"},
        ]
    }

    with patch(
        "app.repository.github_provider.requests.get", return_value=_response(payload)
    ):
        changed = provider.get_changed_files(
            git_domain="github.com", base="aaa", head="bbb", **DOMAIN_ARGS
        )

    assert changed == [
        {"path": "a.py", "status": "A"},
        {"path": "b.py", "status": "M"},
        {"path": "c.py", "status": "D"},
        {"path": "d.py", "status": "R"},
    ]


def test_github_reports_a_truncated_compare_as_unknown():
    """GitHub caps the list at 300 and does not say so; a capped list read as
    complete would understate a change big enough to need a rebuild."""
    provider = GitHubProvider()
    payload = {
        "files": [
            {"filename": f"file{index}.py", "status": "modified"}
            for index in range(GITHUB_COMPARE_FILE_LIMIT)
        ]
    }

    with patch(
        "app.repository.github_provider.requests.get", return_value=_response(payload)
    ):
        changed = provider.get_changed_files(
            git_domain="github.com", base="aaa", head="bbb", **DOMAIN_ARGS
        )

    assert changed is None


def test_github_reports_a_compare_below_the_cap_normally():
    provider = GitHubProvider()
    payload = {
        "files": [
            {"filename": f"file{index}.py", "status": "modified"}
            for index in range(GITHUB_COMPARE_FILE_LIMIT - 1)
        ]
    }

    with patch(
        "app.repository.github_provider.requests.get", return_value=_response(payload)
    ):
        changed = provider.get_changed_files(
            git_domain="github.com", base="aaa", head="bbb", **DOMAIN_ARGS
        )

    assert changed is not None
    assert len(changed) == GITHUB_COMPARE_FILE_LIMIT - 1


# --- GitLab -----------------------------------------------------------------


def test_gitlab_reads_the_default_branch_and_its_commit():
    provider = GitLabProvider()
    responses = [
        _response({"default_branch": "main"}),
        _response({"commit": {"id": "def456"}}),
    ]

    with patch.object(
        GitLabProvider, "_make_request_with_auth_retry", side_effect=responses
    ):
        result = provider.get_default_branch_head(
            git_domain="gitlab.com", **DOMAIN_ARGS
        )

    assert result == {"branch": "main", "commit": "def456"}


def test_gitlab_derives_status_from_the_diff_flags():
    provider = GitLabProvider()
    payload = {
        "diffs": [
            {"new_path": "a.py", "new_file": True},
            {"new_path": "b.py"},
            {"old_path": "c.py", "deleted_file": True},
            {"new_path": "d.py", "renamed_file": True},
        ]
    }

    with patch.object(
        GitLabProvider, "_make_request_with_auth_retry", return_value=_response(payload)
    ):
        changed = provider.get_changed_files(
            git_domain="gitlab.com", base="aaa", head="bbb", **DOMAIN_ARGS
        )

    assert changed == [
        {"path": "a.py", "status": "A"},
        {"path": "b.py", "status": "M"},
        {"path": "c.py", "status": "D"},
        {"path": "d.py", "status": "R"},
    ]


def test_gitlab_reports_a_timed_out_compare_as_unknown():
    """GitLab answers 200 with a partial diff and a flag, so the flag is the only
    thing separating "small change" from "gave up"."""
    provider = GitLabProvider()
    payload = {
        "compare_timeout": True,
        "diffs": [{"new_path": "a.py"}],
    }

    with patch.object(
        GitLabProvider, "_make_request_with_auth_retry", return_value=_response(payload)
    ):
        changed = provider.get_changed_files(
            git_domain="gitlab.com", base="aaa", head="bbb", **DOMAIN_ARGS
        )

    assert changed is None


# --- Gitea ------------------------------------------------------------------


def test_gitea_reads_the_default_branch_and_its_commit():
    provider = GiteaProvider()
    responses = [
        _response({"default_branch": "master"}),
        _response({"commit": {"id": "789abc"}}),
    ]

    with patch("app.repository.gitea_provider.requests.get", side_effect=responses):
        result = provider.get_default_branch_head(git_domain="gitea.com", **DOMAIN_ARGS)

    assert result == {"branch": "master", "commit": "789abc"}


def test_gitea_maps_compare_statuses_to_name_status_letters():
    provider = GiteaProvider()
    payload = {
        "files": [
            {"filename": "a.py", "status": "added"},
            {"filename": "b.py", "status": "changed"},
            {"filename": "c.py", "status": "deleted"},
        ]
    }

    with patch(
        "app.repository.gitea_provider.requests.get", return_value=_response(payload)
    ):
        changed = provider.get_changed_files(
            git_domain="gitea.com", base="aaa", head="bbb", **DOMAIN_ARGS
        )

    assert changed == [
        {"path": "a.py", "status": "A"},
        {"path": "b.py", "status": "M"},
        {"path": "c.py", "status": "D"},
    ]


def test_an_older_gitea_without_a_compare_endpoint_reports_unknown():
    """Self-hosted instances lag; a 404 here must degrade, not raise."""
    provider = GiteaProvider()

    with patch(
        "app.repository.gitea_provider.requests.get",
        return_value=_response({}, status_code=404),
    ):
        changed = provider.get_changed_files(
            git_domain="gitea.example.com", base="aaa", head="bbb", **DOMAIN_ARGS
        )

    assert changed is None
