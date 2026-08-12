# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for reading what a repository is at, before a run is decided.

The value here is entirely in the failure modes. A correct read saves a full rebuild;
a *wrong* read is worse than no read at all, because a partial diff mistaken for a
complete one picks an incremental run for a change that reshaped the repository.

So every case that cannot be answered confidently has to come back as "unknown" —
which the run-mode rules turn into a full rebuild — and never as "nothing changed".
The one exception is pinned too: a repository already at the documented commit really
has an empty diff, and reporting that as unknown would rebuild a wiki that is current.
"""

from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.services.knowledge.code_wiki.repo_state import (
    RepositoryState,
    read_repository_state,
)
from app.services.knowledge.code_wiki.source import (
    SUPPORTED_SOURCE_TYPES,
    SourceRepository,
    provider_for,
)

SOURCE = SourceRepository(
    source_type="github",
    source_url="https://github.com/wecode-ai/Wegent.git",
    project_name="wecode-ai/Wegent",
    source_domain="github.com",
)

HEAD = "bbbbbbb"
PUBLISHED = "aaaaaaa"


class FakeProvider:
    """A provider that answers exactly what a test tells it to."""

    def __init__(self, head=None, files=None, head_raises=False, files_raise=False):
        self._head = head if head is not None else {"branch": "main", "commit": HEAD}
        self._files = files
        self._head_raises = head_raises
        self._files_raise = files_raise
        self.diff_calls = []

    def get_default_branch_head(self, *, token, git_domain, repo_name):
        if self._head_raises:
            raise RuntimeError("provider is down")
        return self._head

    def get_changed_files(self, *, token, git_domain, repo_name, base, head):
        self.diff_calls.append((base, head))
        if self._files_raise:
            raise RuntimeError("compare failed")
        return self._files


def _with(provider, token="t0ken"):
    """Patch the provider lookup and credentials this module reaches for."""
    return (
        patch(
            "app.services.knowledge.code_wiki.repo_state.provider_for",
            return_value=provider,
        ),
        patch(
            "app.services.knowledge.code_wiki.repo_state.get_user_git_info",
            return_value=({"token": token} if token else None),
        ),
    )


def _read(test_db: Session, provider, *, token="t0ken", since=PUBLISHED):
    provider_patch, git_patch = _with(provider, token)
    with provider_patch, git_patch:
        return read_repository_state(
            test_db, user_id=1, source=SOURCE, since_commit=since
        )


# --- the happy path ---------------------------------------------------------


def test_the_default_branch_head_is_read(test_db: Session):
    state = _read(test_db, FakeProvider(), since="")

    assert state.head_commit == HEAD
    assert state.branch == "main"


def test_the_diff_is_read_against_the_published_commit(test_db: Session):
    provider = FakeProvider(
        files=[
            {"path": "backend/app/main.py", "status": "M"},
            {"path": "backend/app/new.py", "status": "A"},
        ]
    )

    state = _read(test_db, provider)

    assert provider.diff_calls == [(PUBLISHED, HEAD)]
    assert [change.path for change in state.changed_paths] == [
        "backend/app/main.py",
        "backend/app/new.py",
    ]
    assert state.changed_paths[1].is_structural_move


def test_a_first_run_asks_for_no_diff(test_db: Session):
    """There is nothing to compare against, and asking would only cost a call."""
    provider = FakeProvider()

    state = _read(test_db, provider, since="")

    assert provider.diff_calls == []
    assert state.changed_paths is None


def test_a_repository_already_at_the_documented_commit_has_an_empty_diff(
    test_db: Session,
):
    """Empty, not unknown. Unknown would rebuild a wiki that is already current."""
    provider = FakeProvider(head={"branch": "main", "commit": PUBLISHED})

    state = _read(test_db, provider)

    assert state.head_commit == PUBLISHED
    assert state.changed_paths == ()
    assert provider.diff_calls == []


# --- everything that cannot be answered -------------------------------------


def test_an_unreachable_provider_leaves_the_state_unknown(test_db: Session):
    state = _read(test_db, FakeProvider(head_raises=True))

    assert state == RepositoryState()


def test_a_missing_credential_leaves_the_state_unknown(test_db: Session):
    state = _read(test_db, FakeProvider(), token="")

    assert state == RepositoryState()


def test_an_unsupported_platform_leaves_the_state_unknown(test_db: Session):
    state = _read(test_db, None)

    assert state == RepositoryState()


def test_a_head_that_cannot_be_read_stops_before_the_diff(test_db: Session):
    provider = FakeProvider(head={"branch": "main", "commit": ""})

    state = _read(test_db, provider)

    assert state.head_commit == ""
    assert provider.diff_calls == []


def test_a_failed_diff_is_unknown_rather_than_empty(test_db: Session):
    """Reported empty, the run would be skipped and the changes never documented."""
    state = _read(test_db, FakeProvider(files_raise=True))

    assert state.head_commit == HEAD
    assert state.changed_paths is None


def test_a_diff_the_provider_would_not_complete_is_unknown(test_db: Session):
    """The provider says ``None`` when it truncated or gave up; that must survive."""
    state = _read(test_db, FakeProvider(files=None))

    assert state.head_commit == HEAD
    assert state.changed_paths is None


def test_a_genuinely_empty_diff_is_kept_as_empty(test_db: Session):
    """The commit moved but nothing changed in it — that is a skip, not a rebuild."""
    state = _read(test_db, FakeProvider(files=[]))

    assert state.changed_paths == ()


# --- the platforms that must be able to answer ------------------------------


@pytest.mark.parametrize("source_type", SUPPORTED_SOURCE_TYPES)
def test_every_supported_platform_can_report_repository_state(source_type: str):
    """A platform a code wiki accepts but cannot read state for would silently
    rebuild from scratch on every run."""
    provider = provider_for(source_type)

    assert provider is not None
    assert hasattr(provider, "get_default_branch_head")
    assert hasattr(provider, "get_changed_files")
