# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the report that tells apart why reading a repository failed.

Its whole purpose is to distinguish causes that look identical to the request that
hit them, so the properties worth pinning are that a failing step does not stop the
rest, that how the call was routed is reported, and that no part of a credential
ever appears in the output.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.knowledge.code_wiki import diagnostics
from app.services.knowledge.code_wiki.diagnostics import diagnose
from app.services.knowledge.code_wiki.source import SourceRepository

TOKEN = "glpat-secret-do-not-leak"
SOURCE = SourceRepository(
    source_type="gitlab",
    source_url="https://gitlab.example.com/team/app.git",
    project_name="team/app",
    source_domain="gitlab.example.com",
)


@pytest.fixture
def provider():
    p = MagicMock()
    p.describe_repository.return_value = {"visibility": "private"}
    p.check_user_project_access.return_value = {"has_access": True}
    p.get_default_branch_head.return_value = {"branch": "main", "commit": "abc"}
    return p


def _run(provider, git_info):
    with (
        patch.object(diagnostics, "get_user_git_info", return_value=git_info),
        patch.object(diagnostics, "provider_for", return_value=provider),
    ):
        return diagnose(MagicMock(), 1, SOURCE)


def test_every_call_a_code_wiki_makes_is_timed(provider):
    report = _run(provider, {"token": TOKEN, "type": "gitlab"})

    names = [step["name"] for step in report["steps"]]
    assert names == [
        "describe_repository (anonymous)",
        "describe_repository (with credential)",
        "check_user_project_access",
        "get_default_branch_head",
    ]
    assert all(step["seconds"] >= 0 for step in report["steps"])


def test_a_failing_step_does_not_stop_the_ones_after_it(provider):
    """The first failure is usually not the informative one — knowing that the
    anonymous probe works while the credentialed one does not is the diagnosis."""
    provider.check_user_project_access.side_effect = RuntimeError("connect timeout")

    report = _run(provider, {"token": TOKEN, "type": "gitlab"})

    by_name = {step["name"]: step for step in report["steps"]}
    assert by_name["check_user_project_access"]["ok"] is False
    assert "RuntimeError" in by_name["check_user_project_access"]["detail"]
    assert by_name["get_default_branch_head"]["ok"] is True


def test_the_credential_never_appears_in_the_report(provider):
    """It is handed to an operator and pasted into tickets."""
    report = _run(provider, {"token": TOKEN, "type": "gitlab"})

    assert TOKEN not in str(report)
    assert report["credential"]["found"] is True
    assert report["credential"]["length"] == len(TOKEN)


def test_a_token_that_failed_to_decrypt_is_visible_as_such(provider):
    """decrypt_sensitive_data returns its input unchanged when it cannot decrypt, so
    a plaintext token and a failed decrypt reach the provider looking identical."""
    # Base64 decoding to a whole number of AES blocks is what the check looks for.
    report = _run(provider, {"token": "MTIzNDU2Nzg5MGFiY2RlZg==", "type": "gitlab"})

    assert report["credential"]["still_looks_encrypted"] is True


def test_how_the_call_was_routed_is_reported(provider, monkeypatch):
    """A process started without the proxy variables reaches an internal host
    directly and one started with them does not. Same code, different networks —
    and the error text alone does not say which happened."""
    monkeypatch.setattr(
        diagnostics,
        "_routing",
        lambda host: {"effective": "http://127.0.0.1:7897", "bypasses_proxy": False},
    )

    report = _run(provider, {"token": TOKEN, "type": "gitlab"})

    assert report["routing"]["effective"] == "http://127.0.0.1:7897"


def test_without_a_credential_only_the_anonymous_probe_runs(provider):
    """Reporting three more failures that all say "no token" would bury the one
    fact that matters."""
    report = _run(provider, None)

    assert [step["name"] for step in report["steps"]] == [
        "describe_repository (anonymous)"
    ]
    assert report["credential"] == {"found": False}


def test_a_provider_mismatch_is_named_rather_than_left_in_the_timings(provider):
    """Asking one provider about a repository hosted by another produces answers
    that read as network faults — a 410 from a retired API version, an "Invalid
    token" for a credential that is fine elsewhere. No single step can see the
    contradiction, because each one only knows its own outcome."""
    report = _run(provider, {"token": TOKEN, "type": "github"})

    assert report["warnings"], "a mismatch must be stated, not inferred"
    assert "gitlab" in report["warnings"][0]
    assert "github" in report["warnings"][0]


def test_matching_types_produce_no_warning(provider):
    report = _run(provider, {"token": TOKEN, "type": "gitlab"})

    assert report["warnings"] == []


def test_a_credential_that_failed_to_decrypt_is_called_out(provider):
    """Otherwise it shows only as a field among a dozen, while every step below
    fails for that one reason."""
    report = _run(provider, {"token": "MTIzNDU2Nzg5MGFiY2RlZg==", "type": "gitlab"})

    assert any("GIT_TOKEN_AES" in warning for warning in report["warnings"])
