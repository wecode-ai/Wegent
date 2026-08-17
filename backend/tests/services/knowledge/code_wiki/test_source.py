# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the repository access gate guarding code wiki creation."""

from unittest.mock import MagicMock, patch

import pytest

from app.services.knowledge.code_wiki.source import (
    SourceAccessDenied,
    SourceRepository,
    assert_user_can_read_source,
)

GITHUB_SOURCE = SourceRepository.from_url(
    "github", "https://github.com/wecode-ai/Wegent.git"
)
GITLAB_SOURCE = SourceRepository.from_url(
    "gitlab", "https://gitlab.example.com/team/app.git"
)


def _granted():
    return {"has_access": True, "access_level_name": "Reporter"}


def test_access_granted_returns_provider_details():
    provider = MagicMock()
    provider.check_user_project_access.return_value = _granted()

    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value={"type": "github", "token": "t0ken"},
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        result = assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)

    assert result["has_access"] is True
    provider.check_user_project_access.assert_called_once_with(
        token="t0ken", git_domain="github.com", repo_name="wecode-ai/Wegent"
    )


def test_gitlab_is_identified_by_project_id():
    provider = MagicMock()
    provider.check_user_project_access.return_value = _granted()

    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value={"type": "gitlab", "token": "t0ken"},
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        assert_user_can_read_source(MagicMock(), 1, GITLAB_SOURCE)

    provider.check_user_project_access.assert_called_once_with(
        token="t0ken", git_domain="gitlab.example.com", project_id="team/app"
    )


def test_a_public_repository_is_readable_without_any_credential():
    """The repository selector only lists repositories the caller belongs to, so
    refusing here would leave a publicly readable repository undocumentable — a wiki
    more closed than its own source."""
    provider = MagicMock()
    provider.describe_repository.return_value = {
        "visibility": "public",
        "default_branch": "main",
        "name": "wecode-ai/Wegent",
        "description": "",
    }
    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value=None,
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        result = assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)

    assert result["has_access"] is True
    # Read and no more: nobody has write access to a repository they reached without
    # a credential, so this can never satisfy the gate on regenerating.
    assert result["access_level"] == 10


def test_a_private_repository_without_a_credential_is_denied():
    provider = MagicMock()
    provider.describe_repository.return_value = None
    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value=None,
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        with pytest.raises(SourceAccessDenied, match="not readable without one"):
            assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)


def test_no_repository_access_is_denied():
    provider = MagicMock()
    provider.check_user_project_access.return_value = {
        "has_access": False,
        "error": "Not a member",
    }

    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value={"type": "github", "token": "t0ken"},
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        with pytest.raises(SourceAccessDenied, match="do not have read access"):
            assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)


def test_provider_error_denies_rather_than_allows():
    """An unreachable provider must not become an open door."""
    provider = MagicMock()
    provider.check_user_project_access.side_effect = RuntimeError("gateway timeout")

    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value={"type": "github", "token": "t0ken"},
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        with pytest.raises(SourceAccessDenied, match="Could not verify access"):
            assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)


def test_unsupported_repository_type_is_refused_at_construction():
    with pytest.raises(SourceAccessDenied, match="Unsupported repository type"):
        SourceRepository.from_url("svn", "svn://example.com/app")


def test_the_checked_repository_is_the_one_that_will_be_cloned():
    """Host and project come from the URL, so they cannot disagree with it.

    Accepting them separately would let a caller pass a repository they can read while
    storing a URL pointing at a private one — the gate would approve one repository and
    the wiki would be built from another.
    """
    source = SourceRepository.from_url(
        "gitlab", "https://gitlab.internal.corp/secret/payroll.git"
    )

    assert source.source_domain == "gitlab.internal.corp"
    assert source.project_name == "secret/payroll"
    assert source.source_url == "https://gitlab.internal.corp/secret/payroll.git"


def test_nested_group_paths_are_preserved():
    source = SourceRepository.from_url(
        "gitlab", "https://gitlab.example.com/weibo_rd/common/wecode/wegent.git"
    )

    assert source.project_name == "weibo_rd/common/wecode/wegent"


def test_credentials_embedded_in_a_url_are_not_stored():
    """The stored URL is visible to everyone who can read the knowledge base."""
    source = SourceRepository.from_url(
        "github", "https://ghp_secrettoken@github.com/owner/repo.git"
    )

    assert "ghp_secrettoken" not in source.source_url
    assert source.source_url == "https://github.com/owner/repo.git"


def test_an_unusable_url_is_refused():
    with pytest.raises(SourceAccessDenied, match="Could not read a repository"):
        SourceRepository.from_url("github", "not-a-url")


def test_credentials_for_another_platform_are_refused():
    """Asking one provider about another's repository gives a meaningless answer."""
    with patch(
        "app.services.knowledge.code_wiki.source.get_user_git_info",
        return_value={"type": "gitlab", "token": "t0ken"},
    ):
        with pytest.raises(SourceAccessDenied, match="configured as 'gitlab'"):
            assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)


def test_source_survives_a_round_trip_through_the_spec():
    assert SourceRepository.from_spec(GITLAB_SOURCE.to_spec()) == GITLAB_SOURCE


def test_a_knowledge_base_without_a_source_reads_as_none():
    assert SourceRepository.from_spec(None) is None
    assert SourceRepository.from_spec({}) is None


# --- what a repository URL may name -----------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://169.254.169.254/owner/repo.git",
        "https://[fe80::1]/owner/repo.git",
        "https://127.0.0.1/owner/repo.git",
        "https://localhost/owner/repo.git",
        # Written the long way round. The first two rely on the standard library
        # folding IPv4-mapped forms into is_loopback/is_link_local, which is worth
        # pinning because it is not this module's behaviour to keep. The last two
        # are neither loopback nor link-local, and still reach the local host.
        "https://[::ffff:127.0.0.1]/owner/repo.git",
        "https://[::ffff:169.254.169.254]/owner/repo.git",
        "https://0.0.0.0/owner/repo.git",
        "https://[::]/owner/repo.git",
    ],
)
def test_a_host_that_is_never_a_git_server_is_refused(url: str):
    """Binding a repository makes the server fetch from the host the URL names,
    carrying the caller's token. The metadata endpoint is link-local and answers
    unauthenticated requests with instance credentials."""
    with pytest.raises(SourceAccessDenied, match="not a reachable repository host"):
        SourceRepository.from_url("gitlab", url)


@pytest.mark.parametrize(
    "url",
    [
        "https://gitlab.internal.example.com/owner/repo.git",
        "https://10.0.0.7/owner/repo.git",
        "https://192.168.1.10/owner/repo.git",
    ],
)
def test_a_self_hosted_host_on_an_internal_network_is_still_allowed(url: str):
    """The normal deployment here. Blocking private ranges would break the product
    to close a much smaller hole than the one above."""
    source = SourceRepository.from_url("gitlab", url)

    assert source.project_name == "owner/repo"


@pytest.mark.parametrize(
    "git_info",
    [
        None,
        {},
        {"type": "github"},
        {"type": "github", "token": ""},
    ],
    ids=["no-record", "empty-record", "no-token-key", "blank-token"],
)
def test_a_credential_record_without_a_usable_token_denies_access(git_info):
    """Every shape of "configured but unusable" has to deny. A record that exists
    but carries no token would otherwise reach the provider with ``None``."""
    provider = MagicMock()
    provider.describe_repository.return_value = None
    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value=git_info,
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        with pytest.raises(SourceAccessDenied, match="not readable without one"):
            assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)


def test_a_public_repository_survives_a_token_that_does_not_reach_it():
    """Both providers answer membership questions, and "not a member" is also the
    answer for a public repository nobody has joined. Without this fallback a stale
    or unrelated token makes a world-readable repository undocumentable."""
    provider = MagicMock()
    provider.check_user_project_access.return_value = {
        "has_access": False,
        "error": "Not a member",
    }
    provider.describe_repository.return_value = {
        "visibility": "public",
        "default_branch": "main",
        "name": "wecode-ai/Wegent",
        "description": "",
    }
    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value={"token": "stale", "type": "github"},
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        result = assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)

    assert result["has_access"] is True
    assert result["access_level"] == 10


def test_a_private_repository_a_token_cannot_reach_is_still_denied():
    """The fallback must not become an open door: when the public probe also says
    no, the original and more specific refusal is what surfaces."""
    provider = MagicMock()
    provider.check_user_project_access.return_value = {
        "has_access": False,
        "error": "Not a member",
    }
    provider.describe_repository.return_value = None
    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value={"token": "stale", "type": "github"},
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        with pytest.raises(SourceAccessDenied, match="do not have read access"):
            assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)


def test_an_unreachable_provider_is_still_denied():
    """A provider that is down fails the public probe too, so the refusal stands."""
    provider = MagicMock()
    provider.check_user_project_access.side_effect = RuntimeError("connection refused")
    provider.describe_repository.return_value = None
    with (
        patch(
            "app.services.knowledge.code_wiki.source.get_user_git_info",
            return_value={"token": "t0ken", "type": "github"},
        ),
        patch(
            "app.services.knowledge.code_wiki.source.provider_for",
            return_value=provider,
        ),
    ):
        with pytest.raises(SourceAccessDenied, match="Could not verify access"):
            assert_user_can_read_source(MagicMock(), 1, GITHUB_SOURCE)
