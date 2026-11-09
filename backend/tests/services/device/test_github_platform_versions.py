# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""GitHub protocol contracts shared with the executor installers."""

import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.services.device.version_checker import GithubVersionChecker


@pytest.fixture
def releases() -> list[dict]:
    fixture = (
        Path(__file__).resolve().parents[4]
        / ".github/fixtures/executor-platform-releases.json"
    )
    return json.loads(fixture.read_text())


def session_for(monkeypatch: pytest.MonkeyPatch, pages: list) -> Mock:
    responses = []
    for page in pages:
        response = Mock()
        response.json.return_value = page
        responses.append(response)
    session = Mock()
    session.get.side_effect = responses
    monkeypatch.setattr(
        "app.services.device.version_checker.traced_session", lambda: session
    )
    return session


def test_selects_platform_release_and_sends_required_headers(monkeypatch, releases):
    session = session_for(monkeypatch, [releases])

    result = GithubVersionChecker()._fetch_latest_version()

    assert result is not None
    assert result.version == "2.0.25"
    session.get.assert_called_once()
    url = session.get.call_args.args[0]
    assert url.endswith("/releases?per_page=100&page=1")
    headers = session.get.call_args.kwargs["headers"]
    assert headers["Accept"] == "application/vnd.github+json"
    assert headers["User-Agent"] == "wegent-backend"
    assert "Authorization" not in headers


def test_paginates_past_desktop_releases_and_preserves_auth(monkeypatch, releases):
    session = session_for(monkeypatch, [[releases[0]] * 100, releases])

    result = GithubVersionChecker(token="test-token")._fetch_latest_version()

    assert result is not None
    assert result.version == "2.0.25"
    assert [call.args[0].rsplit("=", 1)[-1] for call in session.get.call_args_list] == [
        "1",
        "2",
    ]
    for call in session.get.call_args_list:
        assert call.kwargs["headers"]["Authorization"] == "Bearer test-token"


@pytest.mark.parametrize("payload", [[], {}, [{"tag_name": "wework-v0.6.4"}]])
def test_unavailable_or_invalid_catalog_never_becomes_a_platform_version(
    monkeypatch, payload
):
    session_for(monkeypatch, [payload])
    assert GithubVersionChecker()._fetch_latest_version() is None


def test_drafts_and_prereleases_are_not_platform_updates(monkeypatch, releases):
    session_for(monkeypatch, [releases[:3]])
    assert GithubVersionChecker()._fetch_latest_version() is None


def test_http_failure_preserves_unavailable_result(monkeypatch):
    session = session_for(monkeypatch, [[]])
    session.get.side_effect = OSError("protocol fixture network failure")
    assert GithubVersionChecker()._fetch_latest_version() is None
