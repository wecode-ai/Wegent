# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for describing a repository before a wiki is bound to it.

The case worth pinning is the one the repository selector cannot reach: a public
repository the caller is not a member of. It never appears in the list the selector
draws from, and until this existed it could not be documented at all — a wiki more
closed than the repository it describes.
"""

from unittest.mock import patch

import pytest

from app.services.knowledge.code_wiki import resolution
from app.services.knowledge.code_wiki.resolution import resolve_repository
from app.services.knowledge.code_wiki.source import (
    SourceAccessDenied,
    SourceRepository,
)

PUBLIC = {
    "visibility": "public",
    "default_branch": "main",
    "name": "wecode-ai/Wegent",
    "description": "An agent operating system",
}


@pytest.fixture(autouse=True)
def _no_cache(monkeypatch):
    """The cache is an optimisation; these tests are about what is resolved."""
    monkeypatch.setattr(resolution, "_cached", lambda source, *, user_id: None)
    monkeypatch.setattr(
        resolution, "_remember", lambda source, *, user_id, resolved: None
    )


@pytest.fixture
def source() -> SourceRepository:
    return SourceRepository.from_url(
        "github", "https://github.com/wecode-ai/Wegent.git"
    )


def _with(token: str | None, described):
    """Patch the two collaborators: whose token, and what the provider answers."""
    provider = type("P", (), {"describe_repository": lambda self, **kw: described})()
    return (
        patch.object(
            resolution,
            "get_user_git_info",
            return_value={"token": token} if token else None,
        ),
        patch.object(resolution, "provider_for", return_value=provider),
    )


def test_a_public_repository_resolves_without_any_credential(source):
    """The selector only lists repositories the caller belongs to, so this is the
    only way a public repository can be documented at all."""
    git_info, provider = _with(None, PUBLIC)

    with git_info, provider:
        resolved = resolve_repository(db=None, user_id=1, source=source)

    assert resolved.exists is True
    assert resolved.visibility == "public"
    assert resolved.access == "public"
    assert resolved.default_branch == "main"


def test_an_unreadable_repository_is_reported_without_saying_why(source):
    """Private and absent must look alike: telling them apart would disclose which
    private repositories exist."""
    git_info, provider = _with(None, None)

    with git_info, provider:
        resolved = resolve_repository(db=None, user_id=1, source=source)

    assert resolved.exists is False
    assert resolved.visibility == ""
    assert resolved.access == "none"


def test_a_credential_is_used_when_the_caller_has_one(source):
    git_info, provider = _with("ghp_token", {**PUBLIC, "visibility": "private"})

    with git_info, provider:
        resolved = resolve_repository(db=None, user_id=1, source=source)

    assert resolved.access == "member"
    assert resolved.visibility == "private"


def test_the_default_branch_comes_back_so_branches_need_not_be_listed(source):
    """Listing branches has no anonymous path; taking the default from here is what
    lets the create form work for a public repository."""
    git_info, provider = _with(None, {**PUBLIC, "default_branch": "develop"})

    with git_info, provider:
        assert resolve_repository(db=None, user_id=1, source=source).default_branch == (
            "develop"
        )


def test_an_unsupported_type_is_refused_rather_than_probed(source):
    other = SourceRepository(
        source_type="svn",
        source_url="https://example.com/x/y.git",
        project_name="x/y",
        source_domain="example.com",
    )

    with pytest.raises(SourceAccessDenied):
        resolve_repository(db=None, user_id=1, source=other)


def test_an_unreadable_result_is_not_cached(source, monkeypatch):
    """A repository about to be granted to the caller must not stay unreadable for
    the length of the cache because they asked one moment early."""
    remembered = []
    monkeypatch.setattr(
        resolution,
        "_remember",
        lambda source, *, user_id, resolved: remembered.append(resolved),
    )
    git_info, provider = _with(None, None)

    with git_info, provider:
        resolve_repository(db=None, user_id=1, source=source)

    assert remembered == []
