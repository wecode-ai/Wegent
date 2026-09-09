# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Normalization of the merged change-request event used by loop branches."""

from app.services.project_event_sources import normalize_webhook_events


def test_normalize_github_merged_pull_request() -> None:
    events = normalize_webhook_events(
        "github",
        {
            "action": "closed",
            "pull_request": {
                "number": 42,
                "merged": True,
                "merged_at": "2026-08-30T10:00:00Z",
                "html_url": "https://github.example/acme/app/pull/42",
                "head": {"sha": "abc123", "ref": "feat/x"},
            },
            "repository": {
                "full_name": "acme/app",
                "html_url": "https://github.example/acme/app",
            },
        },
        {"x-github-event": "pull_request"},
    )
    assert len(events) == 1
    assert events[0].event_type == "change_request.merged"
    assert events[0].subject["number"] == 42


def test_normalize_github_closed_without_merge_is_ignored() -> None:
    events = normalize_webhook_events(
        "github",
        {
            "action": "closed",
            "pull_request": {
                "number": 43,
                "merged": False,
                "html_url": "https://github.example/acme/app/pull/43",
                "head": {"sha": "def456", "ref": "feat/y"},
            },
            "repository": {
                "full_name": "acme/app",
                "html_url": "https://github.example/acme/app",
            },
        },
        {"x-github-event": "pull_request"},
    )
    assert events == []


def test_normalize_gitlab_merged_merge_request() -> None:
    events = normalize_webhook_events(
        "gitlab",
        {
            "object_kind": "merge_request",
            "project": {"path_with_namespace": "acme/app"},
            "object_attributes": {
                "iid": 7,
                "state": "merged",
                "merged_at": "2026-08-30T10:00:00Z",
                "url": "https://gitlab.example/acme/app/-/merge_requests/7",
            },
        },
        {},
    )
    assert len(events) == 1
    assert events[0].event_type == "change_request.merged"
